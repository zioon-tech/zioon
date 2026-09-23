import { describe, expect, it } from "vitest";
import {
  accountRole, roleScopes, requireAccountScope, intersectAccountPolicy
} from "../src/accounts/account-policy.mjs";

const policy = {
  preset: "trusted-automation", allowedTools: ["read", "Bash", "modelsManage", "sendMail"],
  fileRoots: ["/workspace"], allowedCommandPrefixes: ["jq", "node"],
  allowedTerminalSessionIds: ["terminal:1"], allowedRecipients: ["owner@example.test"],
  maxToolCalls: 10, maxMailPerRun: 2
};

describe("account policy", () => {
  it("keeps execution and control-plane privileges separate from read membership", () => {
    expect(roleScopes("viewer")).toEqual(["runtime.read", "observability.read"]);
    expect(roleScopes("member")).toContain("run.execute");
    expect(roleScopes("member")).not.toContain("runtime.manage");
    expect(roleScopes("admin")).not.toContain("owner.manage");
    expect(() => accountRole("superuser")).toThrow("Unknown Space role");
    expect(() => requireAccountScope({ role: "owner", status: "removed" }, "runtime.read"))
      .toThrow("membership");
    expect(() => requireAccountScope({ role: "viewer", status: "active" }, "run.execute"))
      .toThrow("Permission required");
  });

  it("intersects task limits and removes member control-plane tools", () => {
    const bounded = intersectAccountPolicy({
      ...policy, allowedTools: [...policy.allowedTools, "unlisted"],
      fileRoots: ["/workspace/project"], maxToolCalls: 100, maxMailPerRun: 9
    }, policy, "member");
    expect(bounded).toMatchObject({
      allowedTools: ["read", "Bash"], fileRoots: ["/workspace/project"],
      maxToolCalls: 10, maxMailPerRun: 2
    });
    expect(intersectAccountPolicy(policy, policy, "admin").allowedTools).toContain("modelsManage");
    expect(intersectAccountPolicy(policy, { ...policy, preset: "read-only" }, "owner").preset)
      .toBe("read-only");
    expect(() => intersectAccountPolicy(policy, policy, "viewer")).toThrow("cannot execute");
  });

  it.each([
    ["fileRoots", ["/other"]],
    ["fileRoots", ["/workspace/../secret"]],
    ["fileRoots", ["/workspace2"]],
    ["allowedCommandPrefixes", ["curl"]],
    ["allowedTerminalSessionIds", ["terminal:2"]],
    ["allowedRecipients", ["other@example.test"]]
  ])("rejects disjoint %s rather than making it unrestricted", (field, value) => {
    expect(() => intersectAccountPolicy({ ...policy, [field]: value }, policy, "owner"))
      .toThrow("exceeds the task grant");
  });

  it("preserves ceilings when callers omit optional restrictions", () => {
    const result = intersectAccountPolicy({
      preset: "workspace-write", allowedTools: ["read"], maxToolCalls: 3
    }, policy, "member");
    expect(result.fileRoots).toEqual(["/workspace"]);
    expect(result.allowedCommandPrefixes).toEqual(["jq", "node"]);
    expect(result.allowedRecipients).toEqual([]);
    expect(result.maxToolCalls).toBe(3);
    expect(result.maxMailPerRun).toBe(0);
  });
});
