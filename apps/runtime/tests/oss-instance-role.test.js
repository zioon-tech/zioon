import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOssInstanceRoleCredentials, createOssArtifactStore,
  ossCredentialsFromEnvironment } from "../src/marketplace/artifact-store.mjs";

const role = "ZionRuntimeSandboxProvisioner";
const fixture = (now, id = "fixture-id") => ({ Code: "Success",
  AccessKeyId: id, AccessKeySecret: "fixture-secret", SecurityToken: `session-${id}`,
  Expiration: new Date(now + 900_000).toISOString() });

describe("OSS rotating ECS role credentials", () => {
  it("shares concurrent metadata refresh and renews before expiration", async () => {
    let now = Date.now(), generation = 0;
    const fetchImpl = vi.fn(async (url, options) => {
      expect(options.redirect).toBe("error");
      expect(url).toMatch(/^http:\/\/100\.100\.100\.200\/latest\//);
      if (url.endsWith("/api/token")) return new Response("metadata-token");
      expect(options.headers["X-aliyun-ecs-metadata-token"]).toBe("metadata-token");
      return Response.json(fixture(now, `fixture-${++generation}`));
    });
    const credentials = createOssInstanceRoleCredentials(role, { fetchImpl, now: () => now });
    const first = await Promise.all(Array.from({ length: 20 }, () => credentials()));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.every((value) => value.accessKeyId === "fixture-1")).toBe(true);
    now += 610_000;
    expect((await credentials()).accessKeyId).toBe("fixture-2");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each(["not-a-date", new Date(0).toISOString()])("rejects invalid expiration %s", async (expiration) => {
    const fetchImpl = vi.fn(async (url) => url.endsWith("/api/token")
      ? new Response("token") : Response.json({ ...fixture(Date.now()), Expiration: expiration }));
    await expect(createOssInstanceRoleCredentials(role, { fetchImpl })())
      .rejects.toMatchObject({ code: "artifact_store_credentials_unavailable" });
  });

  it("does not reuse a stale key after renewal fails and can recover later", async () => {
    let now = Date.now(), fail = false;
    const fetchImpl = vi.fn(async (url) => {
      if (fail) throw new Error("fixture-secret upstream URL");
      return url.endsWith("/api/token") ? new Response("token") : Response.json(fixture(now));
    });
    const credentials = createOssInstanceRoleCredentials(role, { fetchImpl, now: () => now });
    await credentials(); now += 610_000; fail = true;
    await expect(credentials()).rejects.toThrow("OSS instance role credentials are unavailable");
    fail = false;
    expect((await credentials()).accessKeyId).toBe("fixture-id");
  });

  it("signs put and verified reads with the latest session credentials", async () => {
    let current = 0, bytes;
    const credentials = async () => ({ accessKeyId: `id-${++current}`,
      accessKeySecret: "fixture-secret", securityToken: `session-${current}` });
    const fetchImpl = async (url, request) => {
      const key = new URL(url).pathname;
      const expected = createHmac("sha1", "fixture-secret").update(
        `${request.method}\n\n${request.headers["content-type"] || ""}\n${request.headers.date}\nx-oss-security-token:session-${current}\n/zioon-artifacts-test${key}`
      ).digest("base64");
      expect(request.headers.authorization).toBe(`OSS id-${current}:${expected}`);
      if (request.method === "PUT") { bytes = request.body; return new Response(null); }
      return new Response(bytes);
    };
    const store = createOssArtifactStore({ endpoint: "https://oss-cn-test.aliyuncs.com",
      bucket: "zioon-artifacts-test", credentialProvider: credentials, fetchImpl });
    const ref = await store.put({ value: "persisted" });
    expect(await store.get(ref)).toEqual({ value: "persisted" });
    expect(current).toBe(3);
  });

  it("requires an explicit role and never accepts a user supplied metadata host", () => {
    expect(() => createOssInstanceRoleCredentials("../another-role")).toThrow("Invalid OSS instance role");
    expect(() => ossCredentialsFromEnvironment({ ZION_OSS_INSTANCE_ROLE: "http://example.test" }))
      .toThrow("Invalid OSS instance role");
  });
});
