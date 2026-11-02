import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  stat,
  unlink
} from "node:fs/promises";
import { dirname, join } from "node:path";

const BLOB_KEY_PATTERN = /^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/;

function storageError(message, {
  code = "ASSET_STORAGE_FAILED",
  statusCode = 500,
  limitBytes
} = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    ...(Number.isSafeInteger(limitBytes) ? { limitBytes } : {})
  });
}

function bufferChunk(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class LocalFilesystemBlobStore {
  constructor({ root }) {
    this.root = String(root || "");
    if (!this.root) throw new Error("Local BlobStore root is required");
    this.temporaryRoot = join(this.root, "tmp");
    this.blobRoot = join(this.root, "blobs");
    this.initialized = null;
  }

  async initialize() {
    if (!this.initialized) {
      this.initialized = Promise.all([
        mkdir(this.root, { recursive: true, mode: 0o700 })
          .then(() => chmod(this.root, 0o700)),
        mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 }),
        mkdir(this.blobRoot, { recursive: true, mode: 0o700 })
      ]).then(async () => {
        const abandoned = await readdir(this.temporaryRoot, {
          withFileTypes: true
        });
        await Promise.all(abandoned
          .filter((entry) => entry.isFile() && entry.name.endsWith(".upload"))
          .map((entry) => unlink(join(this.temporaryRoot, entry.name))));
        return this;
      });
    }
    return await this.initialized;
  }

  pathForKey(key) {
    const normalized = String(key || "");
    if (!BLOB_KEY_PATTERN.test(normalized)) {
      throw storageError("Asset blob key is invalid");
    }
    return join(this.blobRoot, ...normalized.split("/"));
  }

  async stage(stream, { maxBytes }) {
    await this.initialize();
    const limit = Number(maxBytes);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Asset upload limit must be a positive integer");
    }
    const temporaryPath = join(this.temporaryRoot, `${randomUUID()}.upload`);
    const handle = await open(temporaryPath, "wx", 0o600);
    const digest = createHash("sha256");
    const sampleChunks = [];
    let sampleBytes = 0;
    let byteLength = 0;
    try {
      for await (const value of stream) {
        const chunk = bufferChunk(value);
        byteLength += chunk.length;
        if (byteLength > limit) {
          throw storageError(`Asset exceeds ${limit} bytes`, {
            code: "ASSET_TOO_LARGE",
            statusCode: 413,
            limitBytes: limit
          });
        }
        digest.update(chunk);
        if (sampleBytes < 32) {
          const part = chunk.subarray(0, 32 - sampleBytes);
          sampleChunks.push(part);
          sampleBytes += part.length;
        }
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset
          );
          if (!bytesWritten) {
            throw storageError("Asset upload made no write progress");
          }
          offset += bytesWritten;
        }
      }
      if (!byteLength) {
        throw storageError("Asset body is empty", {
          code: "ASSET_EMPTY",
          statusCode: 400
        });
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    await handle.close();

    const sha256 = digest.digest("hex");
    const key = `sha256/${sha256.slice(0, 2)}/${sha256}`;
    const target = this.pathForKey(key);
    let settled = false;
    return {
      byteLength,
      sha256,
      sample: Buffer.concat(sampleChunks),
      async commit() {
        if (settled) throw storageError("Staged Asset is already finalized");
        settled = true;
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        try {
          await link(temporaryPath, target);
        } catch (error) {
          if (error?.code !== "EEXIST") {
            await unlink(temporaryPath).catch(() => {});
            throw error;
          }
        }
        await unlink(temporaryPath).catch(() => {});
        return { key, sha256, byteLength };
      },
      async abort() {
        if (settled) return;
        settled = true;
        await unlink(temporaryPath).catch(() => {});
      }
    };
  }

  async openRead(key, range = null) {
    await this.initialize();
    const path = this.pathForKey(key);
    const metadata = await stat(path);
    const byteLength = Number(metadata.size);
    if (!range) {
      return {
        byteLength,
        start: 0,
        end: Math.max(0, byteLength - 1),
        stream: createReadStream(path)
      };
    }
    const start = Math.max(0, Number(range.start) || 0);
    const requestedEnd = range.end == null
      ? byteLength - 1
      : Number(range.end);
    const end = Math.min(byteLength - 1, requestedEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw storageError("Asset byte range is invalid", {
        code: "ASSET_RANGE_INVALID",
        statusCode: 416
      });
    }
    return {
      byteLength,
      start,
      end,
      stream: createReadStream(path, { start, end })
    };
  }
}
