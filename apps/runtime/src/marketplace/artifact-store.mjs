import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, open, readFile, lstat, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";

const MAX_BYTES = 1024 * 1024;
const failure = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
export const artifactHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function checkRef(ref) {
  if (ref?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(ref.digest)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_BYTES) {
    throw failure("invalid_artifact_reference", "Invalid artifact reference", 422);
  }
}
async function boundedBody(response) {
  if (!response.ok) throw failure("artifact_store_unavailable", "Artifact object cannot be read");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw failure("artifact_size_limit", "Artifact object exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The storage adapter handles bytes only. Account authorization belongs to the
// release/development services; raw keys and signed URLs never reach clients.
export class ArtifactStore {
  constructor(adapter) { this.adapter = adapter; }
  async put(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (!bytes.length || bytes.length > MAX_BYTES) throw failure("artifact_size_limit", "Artifact exceeds 1 MiB", 413);
    const ref = { schemaVersion: 1, digest: artifactHash(bytes), bytes: bytes.length };
    await this.adapter.put(ref.digest, bytes);
    // Do not switch database metadata until the durable object can be read back.
    await this.get(ref);
    return ref;
  }
  async get(ref) {
    checkRef(ref);
    const bytes = await this.adapter.get(ref.digest);
    if (bytes.length !== ref.bytes || artifactHash(bytes) !== ref.digest) {
      throw failure("artifact_integrity_error", "Artifact object digest does not match", 409);
    }
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw failure("artifact_integrity_error", "Artifact object is not valid JSON", 409); }
  }
}

export function createMemoryArtifactStore() {
  const objects = new Map();
  return new ArtifactStore({
    async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async get(key) {
      if (!objects.has(key)) throw failure("artifact_not_found", "Artifact object not found", 404);
      return Buffer.from(objects.get(key));
    }
  });
}

export function createLocalArtifactStore(directory) {
  const root = resolve(directory);
  return new ArtifactStore({
    async put(key, bytes) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure("artifact_store_path", "Artifact store must be a directory");
      const temporary = join(root, `${key}.${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes); await file.sync(); await file.close();
        try { await link(temporary, join(root, key)); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } finally {
        await file.close().catch(() => {});
        await unlink(temporary);
      }
    },
    async get(key) {
      const path = join(root, key);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw failure("artifact_store_path", "Invalid artifact file");
      return readFile(path);
    }
  });
}

export function createOssInstanceRoleCredentials(roleName, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(roleName || "")) {
    throw failure("artifact_store_config", "Invalid OSS instance role");
  }
  let cached, pending;
  const valid = (credential, margin) => credential?.Code === "Success"
    && typeof credential.AccessKeyId === "string" && credential.AccessKeyId
    && typeof credential.AccessKeySecret === "string" && credential.AccessKeySecret
    && typeof credential.SecurityToken === "string" && credential.SecurityToken
    && Number.isFinite(Date.parse(credential.Expiration))
    && Date.parse(credential.Expiration) > now() + margin;
  return async () => {
    if (!valid(cached, 300_000)) {
      pending ||= (async () => {
        try {
          const base = "http://100.100.100.200/latest";
          const tokenResponse = await fetchImpl(`${base}/api/token`, {
            method: "PUT", headers: { "X-aliyun-ecs-metadata-token-ttl-seconds": "21600" },
            signal: AbortSignal.timeout(3000), redirect: "error"
          });
          if (!tokenResponse.ok) throw new Error();
          const token = await tokenResponse.text();
          if (!token || token.length > 4096) throw new Error();
          const response = await fetchImpl(`${base}/meta-data/ram/security-credentials/${roleName}`, {
            headers: { "X-aliyun-ecs-metadata-token": token },
            signal: AbortSignal.timeout(3000), redirect: "error"
          });
          if (!response.ok) throw new Error();
          const credential = await response.json();
          if (!valid(credential, 60_000)) throw new Error();
          cached = credential;
        } catch {
          throw failure("artifact_store_credentials_unavailable", "OSS instance role credentials are unavailable");
        }
      })().finally(() => { pending = null; });
      await pending;
    }
    return { accessKeyId: cached.AccessKeyId, accessKeySecret: cached.AccessKeySecret,
      securityToken: cached.SecurityToken };
  };
}

export function ossCredentialsFromEnvironment(env = process.env) {
  if (env.ZION_OSS_INSTANCE_ROLE) return createOssInstanceRoleCredentials(env.ZION_OSS_INSTANCE_ROLE);
  if (!env.ZION_OSS_ACCESS_KEY_ID || !env.ZION_OSS_ACCESS_KEY_SECRET) {
    throw failure("artifact_store_config", "Configure an OSS instance role or server credentials");
  }
  return async () => ({ accessKeyId: env.ZION_OSS_ACCESS_KEY_ID,
    accessKeySecret: env.ZION_OSS_ACCESS_KEY_SECRET, securityToken: env.ZION_OSS_SECURITY_TOKEN || "" });
}

export function createOssArtifactStore({ endpoint, bucket, accessKeyId, accessKeySecret,
  securityToken = "", credentialProvider, prefix = "zioon/artifacts", fetchImpl = fetch }) {
  let origin;
  try { origin = new URL(endpoint); }
  catch { throw failure("artifact_store_config", "Invalid OSS artifact storage endpoint"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/"
    || origin.search || origin.hash || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || "")
    || !/^[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.split("/").some((p) => !p || p === "..")
    || (credentialProvider ? typeof credentialProvider !== "function" : !accessKeyId || !accessKeySecret)) {
    throw failure("artifact_store_config", "Invalid OSS artifact storage configuration");
  }
  const host = `${bucket}.${origin.host}`;
  async function request(method, digest, bytes) {
    const credential = credentialProvider
      ? await credentialProvider() : { accessKeyId, accessKeySecret, securityToken };
    if (!credential?.accessKeyId || !credential.accessKeySecret) {
      throw failure("artifact_store_credentials_unavailable", "OSS credentials are unavailable");
    }
    const key = `${prefix}/${digest}.json`;
    const date = new Date().toUTCString();
    const contentType = method === "PUT" ? "application/json" : "";
    const ossHeaders = credential.securityToken ? `x-oss-security-token:${credential.securityToken}\n` : "";
    const signature = createHmac("sha1", credential.accessKeySecret)
      .update(`${method}\n\n${contentType}\n${date}\n${ossHeaders}/${bucket}/${key}`).digest("base64");
    const headers = { date, authorization: `OSS ${credential.accessKeyId}:${signature}`,
      ...(contentType ? { "content-type": contentType } : {}),
      ...(credential.securityToken ? { "x-oss-security-token": credential.securityToken } : {}) };
    try {
      return await fetchImpl(`https://${host}/${key}`, { method, headers, redirect: "error",
        signal: AbortSignal.timeout(30000), ...(bytes ? { body: bytes } : {}) });
    } catch { throw failure("artifact_store_unavailable", "OSS artifact storage is unavailable"); }
  }
  return new ArtifactStore({
    async put(key, bytes) {
      const response = await request("PUT", key, bytes);
      if (!response.ok) { await response.body?.cancel(); throw failure("artifact_store_unavailable", "Artifact object cannot be stored"); }
      await response.body?.cancel();
    },
    async get(key) { return boundedBody(await request("GET", key)); }
  });
}

export function artifactStoreFromEnvironment(env = process.env) {
  if (env.ZION_ARTIFACT_STORE === "local") {
    if (env.ZION_ENV !== "development" || !env.ZION_ARTIFACT_DIRECTORY) {
      throw failure("artifact_store_config", "Local artifact storage requires explicit development mode and directory");
    }
    return createLocalArtifactStore(env.ZION_ARTIFACT_DIRECTORY);
  }
  if (env.ZION_ARTIFACT_STORE !== "oss") {
    throw failure("artifact_store_config", "Set ZION_ARTIFACT_STORE=oss and configure private OSS artifact storage");
  }
  return createOssArtifactStore({
    endpoint: env.ZION_OSS_ENDPOINT, bucket: env.ZION_OSS_BUCKET,
    credentialProvider: ossCredentialsFromEnvironment(env), prefix: env.ZION_OSS_ARTIFACT_PREFIX || "zioon/artifacts"
  });
}
