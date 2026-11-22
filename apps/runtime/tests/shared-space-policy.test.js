import { describe, expect, it } from "vitest";
import {
  effectiveDocumentAccess, requireDocumentAccess, requireSpaceExecution,
  validateDocumentAudience, sourceAllowsAudience, bindingProjection, publicProjection,
  invitationRecipient, integerLimit
} from "../src/spaces/space-policy.mjs";

const input = (changes = {}) => ({
  userId: "partner",
  space: { id: "shared", allowExternal: false },
  document: { id: "trip", spaceId: "shared", lifecycle: "active",
    protection: "space", audienceMode: "space" },
  membership: { role: "member", status: "active" },
  grants: [], groupIds: [], now: 1000, ...changes
});
const grant = (subjectId, role, subjectType = "user") => ({ subjectId, role, subjectType });

describe("shared Space relationship policy", () => {
  it("lets owners govern an explicitly inherited document and never a restricted one", () => {
    const owner = input({ membership: { role: "owner", status: "active" } });
    expect(requireDocumentAccess(owner, "manage").role).toBe("manager");
    expect(() => requireDocumentAccess({
      ...owner, document: { ...owner.document, protection: "restricted", audienceMode: "specific" }
    })).toThrow("Document not found");
  });

  it("explains a higher group grant despite an individually read-only grant", () => {
    const access = effectiveDocumentAccess(input({
      document: { ...input().document, audienceMode: "specific" },
      grants: [grant("partner", "viewer"), grant("crew", "editor", "group")],
      groupIds: ["crew"]
    }));
    expect(access.role).toBe("editor");
    expect(access.effectiveSources).toEqual([{ type: "group", id: "crew", role: "editor" }]);
  });

  it("does not use expired grants or removed membership", () => {
    const document = { ...input().document, audienceMode: "specific" };
    expect(effectiveDocumentAccess(input({
      document, grants: [{ ...grant("partner", "manager"), expiresAt: 999 }]
    })).role).toBe("none");
    expect(effectiveDocumentAccess(input({
      document, membership: { role: "owner", status: "removed" },
      grants: [grant("partner", "manager")]
    })).role).toBe("none");
  });

  it("does not turn an invalid external editor grant into a valid guest", () => {
    const guest = input({
      membership: null, space: { id: "shared", allowExternal: true },
      document: { ...input().document, protection: "external" },
      grants: [grant("partner", "editor")]
    });
    expect(effectiveDocumentAccess(guest).role).toBe("none");
    expect(effectiveDocumentAccess({ ...guest, grants: [grant("partner", "commenter")] }).role)
      .toBe("commenter");
  });

  it("requires explicit Space execution even when a viewer has a document edit grant", () => {
    const reader = input({ membership: { role: "viewer", status: "active" },
      grants: [grant("partner", "editor")] });
    expect(requireDocumentAccess(reader, "edit").role).toBe("editor");
    expect(() => requireSpaceExecution(reader.membership)).toThrow("Space execution");
  });

  it("denies objects from another scope without leaking titles", () => {
    const foreign = input({ document: { ...input().document, spaceId: "work-private",
      title: "private business plan" } });
    expect(() => requireDocumentAccess(foreign)).toThrow("Document not found");
    expect(() => requireDocumentAccess(foreign)).not.toThrow("private business plan");
  });

  it("does not use a creator label or contact label as an access grant", () => {
    const document = { ...input().document, protection: "restricted", audienceMode: "specific",
      createdBy: "partner" };
    expect(effectiveDocumentAccess(input({ document, contactOf: "owner" })).role).toBe("none");
  });

  it("rejects grouped restricted audiences and an unknown enum", () => {
    expect(() => validateDocumentAudience({
      protection: "restricted", audienceMode: "specific",
      grants: [grant("crew", "editor", "group")], groupIds: ["crew"], memberIds: ["partner"]
    })).toThrow("restricted_requires_named_people");
    expect(effectiveDocumentAccess(input({
      document: { ...input().document, protection: "unknown-future-policy" }
    })).role).toBe("none");
  });

  it("validates named-only changes as complete replacement lists", () => {
    expect(validateDocumentAudience({
      protection: "restricted", audienceMode: "specific",
      grants: [grant("partner", "manager")], memberIds: ["partner"], groupIds: ["crew"]
    })).toEqual({ protection: "restricted", audienceMode: "specific",
      grants: [grant("partner", "manager")] });
    expect(() => validateDocumentAudience({
      protection: "space", audienceMode: "specific", memberIds: ["partner"], groupIds: [],
      grants: [grant("partner", "editor"), grant("partner", "viewer")]
    })).toThrow("duplicate_grant");
  });

  it("requires external policy and read/comment-only roles for a named guest", () => {
    const change = { protection: "external", audienceMode: "specific",
      grants: [grant("outside", "viewer")], memberIds: ["partner"], groupIds: [] };
    expect(() => validateDocumentAudience(change)).toThrow("external_grant_disallowed");
    expect(validateDocumentAudience({ ...change, allowExternal: true }).grants).toHaveLength(1);
    expect(() => validateDocumentAudience({
      ...change, allowExternal: true, grants: [grant("outside", "manager")]
    })).toThrow("external_grant_disallowed");
  });
});

describe("sharing sources and capability DTOs", () => {
  it("blocks a personally readable source from dynamic all-Space output", () => {
    const source = { spaceId: "shared", protection: "restricted", audienceMode: "specific" };
    const destination = { spaceId: "shared", protection: "space", audienceMode: "space" };
    expect(sourceAllowsAudience({ source, destination,
      sourceUsers: ["partner"], destinationUsers: ["partner", "owner"] })).toBe(false);
  });

  it("permits restricted subset output without broadening the source", () => {
    const source = { spaceId: "shared", protection: "restricted", audienceMode: "specific" };
    expect(sourceAllowsAudience({ source, destination: source,
      sourceUsers: ["partner", "owner"], destinationUsers: ["partner"] })).toBe(true);
    expect(sourceAllowsAudience({ source, destination: source,
      sourceUsers: ["partner"], destinationUsers: ["owner"] })).toBe(false);
  });

  it("does not rely on a coincidentally equal present-day membership for a dynamic audience", () => {
    expect(sourceAllowsAudience({
      source: { spaceId: "shared", protection: "space", audienceMode: "specific" },
      destination: { spaceId: "shared", protection: "space", audienceMode: "space" },
      sourceUsers: ["partner", "owner"], destinationUsers: ["partner", "owner"]
    })).toBe(false);
  });

  it("uses a whitelist for provided capability projections", () => {
    const model = { id: "b", spaceId: "shared", kind: "model", name: "Reasoning",
      status: "active", revision: 1, audienceMode: "space", limits: { calls: 10 },
      privateConfig: { apiKey: "never-export" }, credentialRef: "key-secret", endpoint: "private-origin" };
    const dto = bindingProjection(model, { id: "owner", name: "Owner", email: "private-email" });
    expect(JSON.stringify(dto)).not.toMatch(/never-export|key-secret|private-origin|private-email/);
    dto.limits.calls = 1;
    expect(model.limits.calls).toBe(10);
  });

  it("publishes a reviewed immutable body projection instead of an internal Session DTO", () => {
    expect(() => publicProjection({ title: "Trip", markdown: "body", revision: 1 }))
      .toThrow("publication_review_required");
    expect(publicProjection({
      title: "Trip", markdown: "reviewed body", revision: 7, reviewed: true,
      internalThoughts: "never-export", authorEmail: "private"
    })).toEqual({ title: "Trip", markdown: "reviewed body", revision: 7, indexRequested: false });
  });

  it("keeps stable identity invitations distinct from verified-address invitations", () => {
    expect(invitationRecipient({ userId: "stable-user", email: "ignored@invalid.test" }))
      .toEqual({ userId: "stable-user", email: null });
    expect(invitationRecipient({ email: " Partner@Example.Test " }))
      .toEqual({ userId: null, email: "partner@example.test" });
    expect(() => invitationRecipient({ email: "not-an-address" })).toThrow("recipient_required");
  });

  it("rejects fractional, negative and imprecise integer budgets", () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => integerLimit(value)).toThrow("invalid_integer_limit");
    }
    expect(integerLimit(10)).toBe(10);
  });
});
