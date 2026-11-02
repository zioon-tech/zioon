import OSS from "ali-oss";

// agent-fs' S3 client forces path-style URLs. Use OSS' native SDK through the
// upstream StorageAdapter contract rather than patching its filesystem core.
export class OssStorageAdapter {
  client: OSS;
  versioningEnabled = false;
  get capabilities() { return { versioning: this.versioningEnabled, presignedUrls: false }; }

  constructor(env = process.env) {
    for (const key of ["OSS_BUCKET", "OSS_REGION", "OSS_ENDPOINT", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"]) {
      if (!env[key]) throw new Error(`Missing ${key}`);
    }
    this.client = new OSS({
      bucket: env.OSS_BUCKET, region: env.OSS_REGION, endpoint: env.OSS_ENDPOINT,
      accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
      ...(env.OSS_STS_TOKEN ? { stsToken: env.OSS_STS_TOKEN } : {}),
      secure: true, timeout: 30_000
    });
    this.bucket = env.OSS_BUCKET;
  }
  async putObject(key, body, metadata?, contentType?) {
    const result = await this.client.put(key, Buffer.from(body), {
      headers: { ...(contentType ? { "Content-Type": contentType } : {}),
        ...Object.fromEntries(Object.entries(metadata || {}).map(([k, v]) => [`x-oss-meta-${k}`, v])) }
    });
    return this.versionResult(result);
  }
  async getObject(key, versionId?, opts?) {
    opts?.abortSignal?.throwIfAborted();
    const result = await this.client.get(key, { ...(versionId ? { versionId } : {}) });
    opts?.abortSignal?.throwIfAborted();
    return { body: new Uint8Array(result.content), contentType: result.res.headers["content-type"],
      size: result.content.length, ...this.versionResult(result) };
  }
  async deleteObject(key) { await this.client.delete(key); }
  async copyObject(fromKey, toKey) {
    return this.versionResult(await this.client.copy(toKey, fromKey));
  }
  async headObject(key) {
    const result = await this.client.head(key);
    return { size: Number(result.res.headers["content-length"] || 0),
      contentType: result.res.headers["content-type"],
      lastModified: new Date(result.res.headers["last-modified"]), ...this.versionResult(result) };
  }
  async listObjects(prefix, options = {}) {
    const objects = [], prefixes = new Set(), seen = new Set();
    let marker = "";
    do {
      const result = await this.client.list({
        prefix, marker, "max-keys": 1000,
        ...(options.delimiter !== undefined ? { delimiter: options.delimiter } : {})
      }, {});
      objects.push(...(result.objects || []).map((object) => ({
        key: object.name, size: Number(object.size), lastModified: new Date(object.lastModified), etag: object.etag
      })));
      for (const value of result.prefixes || []) prefixes.add(value);
      if (!result.isTruncated) break;
      marker = result.nextMarker;
      if (!marker || seen.has(marker)) throw new Error("Invalid OSS listing continuation");
      seen.add(marker);
    } while (true);
    return { objects, prefixes: [...prefixes] };
  }
  async listObjectVersions(key) {
    const versions = [], seen = new Set();
    let keyMarker, versionIdMarker;
    do {
      const result = await this.client.getBucketVersions({
        prefix: key, "max-keys": 1000,
        ...(keyMarker ? { "key-marker": keyMarker, "version-id-marker": versionIdMarker } : {})
      });
      versions.push(...(result.objects || []).filter((v) => v.name === key).map((v) => ({
        versionId: v.versionId, size: Number(v.size),
        lastModified: new Date(v.lastModified), isLatest: v.isLatest === true || v.isLatest === "true"
      })));
      if (!(result.isTruncated === true || result.isTruncated === "true")) break;
      keyMarker = result.nextKeyMarker;
      versionIdMarker = result.nextVersionIdMarker;
      const cursor = JSON.stringify([keyMarker, versionIdMarker]);
      if (!keyMarker || seen.has(cursor)) throw new Error("Invalid OSS versions continuation");
      seen.add(cursor);
    } while (true);
    return versions;
  }
  async checkVersioningEnabled() {
    const result = await this.client.getBucketVersioning(this.bucket);
    this.versioningEnabled = result.versionStatus === "Enabled";
    return this.versioningEnabled;
  }
  async enableVersioning() {
    // Bucket settings are an operator decision; startup never mutates them.
    throw new Error("Enable OSS Bucket versioning in the operator console first");
  }
  async getPresignedUrl() { throw new Error("Use the authenticated agent-fs raw endpoint"); }
  versionResult(result) {
    const headers = result.res?.headers || {};
    return { etag: headers.etag, versionId: headers["x-oss-version-id"] };
  }
}
