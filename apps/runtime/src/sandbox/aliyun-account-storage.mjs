import { createHmac, randomUUID } from "node:crypto";
import Nas from "@alicloud/nas20170626";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { provisioningError } from "./account-workspace-provisioner.mjs";
import { fingerprint } from "../../../../packages/sandbox/src/provider.mjs";

const encode = (value) => encodeURIComponent(String(value)).replace(
  /[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
);
const trust = { Version: "1", Statement: [
  { Effect: "Allow", Principal: { Service: ["fc.aliyuncs.com"] }, Action: "sts:AssumeRole" }
] };

/** Uses rotating instance-role credentials only. No operator AK/SK is persisted
 * or passed to a sandbox. Sandbox roles can mount exactly their access point. */
export class AliyunAccountStorage {
  constructor(config, { fetch: transport = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetch = transport;
    this.now = now;
    for (const field of ["region", "zone", "fileSystemId", "cloudAccountId", "vpcId",
      "vSwitchId", "securityGroupId", "instanceRoleName"]) {
      if (!/^[A-Za-z0-9-]+$/.test(config?.[field] || "")) throw new Error(`Invalid storage config: ${field}`);
    }
    if (!Array.isArray(config.storageNetwork?.allowOut)) throw new Error("Storage network is required");
  }

  async credentials() {
    if (this.credential && Date.parse(this.credential.Expiration) - this.now() > 300_000) return this.credential;
    const base = "http://100.100.100.200/latest";
    const tokenResponse = await this.fetch(`${base}/api/token`, {
      method: "PUT", headers: { "X-aliyun-ecs-metadata-token-ttl-seconds": "21600" },
      signal: AbortSignal.timeout(3000), redirect: "error"
    });
    if (!tokenResponse.ok) throw provisioningError("sandbox_provisioning_credentials_unavailable");
    const token = await tokenResponse.text();
    const response = await this.fetch(
      `${base}/meta-data/ram/security-credentials/${this.config.instanceRoleName}`, {
        headers: { "X-aliyun-ecs-metadata-token": token },
        signal: AbortSignal.timeout(3000), redirect: "error"
      }
    );
    if (!response.ok) throw provisioningError("sandbox_provisioning_credentials_unavailable");
    const credential = await response.json();
    if (credential.Code !== "Success" || !credential.AccessKeyId
      || !credential.AccessKeySecret || !credential.SecurityToken
      || Date.parse(credential.Expiration) <= this.now() + 60_000) {
      throw provisioningError("sandbox_provisioning_credentials_unavailable");
    }
    this.credential = credential;
    return credential;
  }

  async nas(method, requestType, params) {
    const credential = await this.credentials();
    const module = await import("@alicloud/nas20170626");
    const client = new Nas.default(new $OpenApiUtil.Config({
      accessKeyId: credential.AccessKeyId, accessKeySecret: credential.AccessKeySecret,
      securityToken: credential.SecurityToken, regionId: this.config.region,
      endpoint: `nas.${this.config.region}.aliyuncs.com`,
      globalParameters: new $OpenApiUtil.GlobalParameters({ queries: { RegionId: this.config.region } }),
      readTimeout: 20_000, connectTimeout: 5000
    }));
    try { return (await client[method](new module[requestType](params))).body; }
    catch (error) {
      throw Object.assign(provisioningError("sandbox_storage_api_failed"), {
        providerCode: String(error?.code || "").slice(0, 100),
        rejected: Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500
      });
    }
  }

  async ram(action, parameters) {
    const credential = await this.credentials();
    const values = {
      Action: action, Version: "2015-05-01", Format: "JSON",
      AccessKeyId: credential.AccessKeyId, SecurityToken: credential.SecurityToken,
      SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
      SignatureNonce: randomUUID(), Timestamp: new Date(this.now()).toISOString().replace(/\.\d+Z$/, "Z"),
      ...parameters
    };
    const canonical = Object.keys(values).sort().map((key) => `${encode(key)}=${encode(values[key])}`).join("&");
    values.Signature = createHmac("sha1", `${credential.AccessKeySecret}&`)
      .update(`POST&%2F&${encode(canonical)}`).digest("base64");
    const response = await this.fetch("https://ram.aliyuncs.com", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values), signal: AbortSignal.timeout(20_000), redirect: "error"
    });
    const result = await response.json();
    if (!response.ok || result.Code) {
      throw Object.assign(provisioningError("sandbox_storage_role_failed"), {
        providerCode: String(result.Code || response.status).slice(0, 100)
      });
    }
    return result;
  }

  async listAccessPoints(agenticSpaceId) {
    let nextToken;
    const points = [];
    do {
      const response = await this.nas("listAccessPoints", "ListAccessPointsRequest", {
        fileSystemId: this.config.fileSystemId, maxResults: 100, nextToken,
        filters: [{ name: "AgenticSpaceId", value: agenticSpaceId }]
      });
      points.push(...(response.accessPoints || []));
      nextToken = response.nextToken;
      if (points.length > 1000) throw provisioningError("sandbox_storage_binding_conflict");
    } while (nextToken);
    return points;
  }

  async provision({ accountId, workspaceId, key, resources, save, assertOwned }) {
    const cfg = this.config;
    const path = `/zion_account_${key}/`;
    let agenticSpaceId = resources.agenticSpaceId;
    if (!agenticSpaceId) {
      await assertOwned();
      // NAS accepts a client token; repeat calls after interruption are safe.
      const response = await this.nas("createAgenticSpace", "CreateAgenticSpaceRequest", {
        fileSystemId: cfg.fileSystemId, fileSystemPath: path, azone: cfg.zone,
        clientToken: `zion-volume-${key}`, description: `Zion-account-${key}`,
        quota: { fileCountLimit: cfg.fileCountLimit || 10000, sizeLimit: cfg.sizeLimit || 10737418240 }
      });
      agenticSpaceId = response.agenticSpaceId;
      if (!agenticSpaceId) throw provisioningError("sandbox_storage_api_failed");
      await save({ agenticSpaceId, path });
    }
    const space = (await this.nas("getAgenticSpace", "GetAgenticSpaceRequest", {
      fileSystemId: cfg.fileSystemId, agenticSpaceId
    })).agenticSpace;
    if (space?.fileSystemPath !== path || space.fileSystemId !== cfg.fileSystemId
      || space.status !== "Running") throw provisioningError("sandbox_storage_binding_conflict");

    let accessPointId = resources.accessPointId;
    if (!accessPointId) {
      const points = await this.listAccessPoints(agenticSpaceId);
      if (points.length > 1) throw provisioningError("sandbox_storage_binding_conflict");
      accessPointId = points[0]?.accessPointId;
      if (!accessPointId) {
        // This API has no client token. Never issue a second create while an
        // earlier transport failure might still be creating an access point.
        if (resources.accessPointIntent) throw provisioningError("sandbox_provisioning_outcome_unknown");
        await save({ accessPointIntent: this.now() });
        await assertOwned();
        try {
          const point = (await this.nas("createAccessPoint", "CreateAccessPointRequest", {
            fileSystemId: cfg.fileSystemId, agenticSpaceId, enabledRam: true,
            accessPointName: `zion-account-${key}`, vpcId: cfg.vpcId, vswId: cfg.vSwitchId
          })).accessPoint;
          accessPointId = point?.accessPointId;
        } catch (error) {
          if (error.rejected) await save({ accessPointIntent: null });
          throw error;
        }
        if (!accessPointId) throw provisioningError("sandbox_provisioning_outcome_unknown");
      }
      await save({ accessPointId });
    }
    let point;
    for (let attempt = 0; attempt < 30; attempt++) {
      await assertOwned();
      point = (await this.nas("describeAccessPoint", "DescribeAccessPointRequest", {
        fileSystemId: cfg.fileSystemId, accessPointId
      })).accessPoint;
      if (String(point?.status).toLowerCase() === "active") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!point?.enabledRam || point.agenticSpaceId !== agenticSpaceId
      || point.fileSystemId !== cfg.fileSystemId || point.vpcId !== cfg.vpcId
      || point.vSwitchId !== cfg.vSwitchId || !point.domainName
      || point.ARN !== `acs:nas:${cfg.region}:${cfg.cloudAccountId}:accesspoint/${accessPointId}`
      || String(point.status).toLowerCase() !== "active") {
      throw provisioningError("sandbox_storage_binding_conflict");
    }
    const roleName = `ZionManaged${key}`;
    let role;
    try { role = (await this.ram("GetRole", { RoleName: roleName })).Role; }
    catch (error) {
      if (error.providerCode !== "EntityNotExist.Role") throw error;
      await assertOwned();
      role = (await this.ram("CreateRole", {
        RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify(trust),
        Description: `Zion managed account ${key}`
      })).Role;
    }
    const expectedArn = `acs:ram::${cfg.cloudAccountId}:role/${roleName.toLowerCase()}`;
    if (role?.Arn !== expectedArn
      || fingerprint(JSON.parse(role.AssumeRolePolicyDocument)) !== fingerprint(trust)) {
      throw provisioningError("sandbox_storage_binding_conflict");
    }
    await save({ roleName, roleArn: role.Arn });
    const policyName = `ZionManaged${key}`;
    const policy = { Version: "1", Statement: [{
      Effect: "Allow", Action: ["nas:ClientMount", "nas:ClientWrite", "nas:ClientRootAccess"],
      Resource: `acs:nas:${cfg.region}:${cfg.cloudAccountId}:filesystem/${cfg.fileSystemId}`,
      Condition: { StringEquals: { "nas:AccessPointArn": point.ARN } }
    }] };
    let policyMetadata;
    try { policyMetadata = (await this.ram("GetPolicy", { PolicyType: "Custom", PolicyName: policyName })).Policy; }
    catch (error) {
      if (error.providerCode !== "EntityNotExist.Policy") throw error;
      await assertOwned();
      policyMetadata = (await this.ram("CreatePolicy", {
        PolicyName: policyName, PolicyDocument: JSON.stringify(policy),
        Description: `Zion scoped account storage ${key}`
      })).Policy;
    }
    const stored = await this.ram("GetPolicyVersion", {
      PolicyType: "Custom", PolicyName: policyName, VersionId: policyMetadata.DefaultVersion
    });
    if (fingerprint(JSON.parse(stored.PolicyVersion.PolicyDocument))
      !== fingerprint(policy)) throw provisioningError("sandbox_storage_binding_conflict");
    await assertOwned();
    await this.ram("AttachPolicyToRole", { PolicyType: "Custom", PolicyName: policyName, RoleName: roleName });
    const attached = (await this.ram("ListPoliciesForRole", { RoleName: roleName })).Policies?.Policy || [];
    if (attached.length !== 1 || attached[0].PolicyName !== policyName || attached[0].PolicyType !== "Custom") {
      throw provisioningError("sandbox_storage_binding_conflict");
    }
    await save({ policyName });
    return {
      accountId, workspaceId, storageNetwork: cfg.storageNetwork,
      storageMetadata: {
        "fc.sandbox.storage.agenticfs": JSON.stringify({
          userID: 0, groupID: 0, mountPoints: [{ serverAddr: `${point.domainName}:/`, mountDir: "/workspace" }]
        }),
        "fc.sandbox.network.vpc": JSON.stringify({
          vpcId: cfg.vpcId, securityGroupId: cfg.securityGroupId, vSwitchIds: [cfg.vSwitchId]
        }),
        "fc.sandbox.auth.role": role.Arn
      }
    };
  }
}
