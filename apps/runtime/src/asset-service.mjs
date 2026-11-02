import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

export const ASSET_URI_PREFIX = "zion-asset://";

const IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function assetError(message, {
  code = "ASSET_INVALID",
  statusCode = 400,
  limitBytes
} = {}) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    ...(Number.isSafeInteger(limitBytes) ? { limitBytes } : {})
  });
}

function normalizedMediaType(value) {
  const mediaType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mediaType === "image/jpg" ? "image/jpeg" : mediaType;
}

function safeOriginalName(value) {
  const name = String(value || "")
    .replace(/[/\\]/g, "")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return name ? name.slice(0, 255) : "";
}

export function detectImageMediaType(sample) {
  const bytes = Buffer.from(sample || []);
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) return "image/png";
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.length >= 6
    && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  ) return "image/gif";
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (
    bytes.length >= 12
    && bytes.subarray(4, 8).toString("ascii") === "ftyp"
    && ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))
  ) return "image/avif";
  return "";
}

export function assetIdFromUri(value) {
  const source = String(value || "");
  if (!source.startsWith(ASSET_URI_PREFIX)) return null;
  const id = source.slice(ASSET_URI_PREFIX.length);
  return /^[a-zA-Z0-9._:-]{1,200}$/.test(id) ? id : null;
}

export function assetUri(assetId) {
  return `${ASSET_URI_PREFIX}${assetId}`;
}

function referencedAssets(messages = []) {
  const ids = new Set();
  let legacy = false;
  let invalid = false;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "image_url") continue;
      const source = String(part.image_url?.url || "");
      if (source.startsWith("app://img/")) legacy = true;
      if (!source.startsWith(ASSET_URI_PREFIX)) continue;
      const id = assetIdFromUri(source);
      if (id) ids.add(id);
      else invalid = true;
    }
  }
  return { ids: [...ids], legacy, invalid };
}

export function publicAsset(asset) {
  return {
    schemaVersion: 1,
    id: asset.id,
    uri: assetUri(asset.id),
    state: asset.state,
    mediaKind: asset.mediaKind,
    mediaType: asset.mediaType,
    byteLength: asset.byteLength,
    sha256: asset.sha256,
    ...(asset.originalName ? { originalName: asset.originalName } : {}),
    createdAt: asset.createdAt
  };
}

export class AssetService {
  constructor({
    blobs,
    metadata,
    maxImageBytes = 16 * 1024 * 1024,
    now = () => Date.now(),
    createId = () => `asset_${randomUUID().replaceAll("-", "")}`
  }) {
    if (!blobs?.stage || !blobs?.openRead) {
      throw new Error("AssetService requires a BlobStore");
    }
    if (!metadata?.create || !metadata?.get) {
      throw new Error("AssetService requires an Asset metadata store");
    }
    this.blobs = blobs;
    this.metadata = metadata;
    this.maxImageBytes = Number(maxImageBytes);
    this.now = now;
    this.createId = createId;
  }

  async createImage({
    stream,
    ownerId = "runtime-local",
    declaredMediaType,
    originalName,
    declaredBytes
  }) {
    if (
      Number.isFinite(Number(declaredBytes))
      && Number(declaredBytes) > this.maxImageBytes
    ) {
      throw assetError(`Image exceeds ${this.maxImageBytes} bytes`, {
        code: "ASSET_TOO_LARGE",
        statusCode: 413,
        limitBytes: this.maxImageBytes
      });
    }
    const staged = await this.blobs.stage(stream, {
      maxBytes: this.maxImageBytes
    });
    try {
      const detectedMediaType = detectImageMediaType(staged.sample);
      if (!IMAGE_MEDIA_TYPES.has(detectedMediaType)) {
        throw assetError("Only PNG, JPEG, GIF, WebP, and AVIF images are supported", {
          code: "ASSET_TYPE_UNSUPPORTED",
          statusCode: 415
        });
      }
      const declared = normalizedMediaType(declaredMediaType);
      if (declared && declared !== "application/octet-stream" && declared !== detectedMediaType) {
        throw assetError("Declared image type does not match file content", {
          code: "ASSET_TYPE_MISMATCH",
          statusCode: 415
        });
      }
      const blob = await staged.commit();
      return await this.metadata.create({
        id: this.createId(),
        ownerId: String(ownerId || "runtime-local"),
        state: "ready",
        mediaKind: "image",
        mediaType: detectedMediaType,
        byteLength: blob.byteLength,
        sha256: blob.sha256,
        blobKey: blob.key,
        originalName: safeOriginalName(originalName),
        createdAt: this.now()
      });
    } catch (error) {
      await staged.abort();
      throw error;
    }
  }

  async get(assetId) {
    return await this.metadata.get(String(assetId || ""));
  }

  async requireReady(assetId) {
    const asset = await this.get(assetId);
    if (!asset) {
      throw assetError("Asset not found", {
        code: "ASSET_NOT_FOUND",
        statusCode: 404
      });
    }
    if (asset.state !== "ready") {
      throw assetError(`Asset is not ready: ${asset.state}`, {
        code: "ASSET_NOT_READY",
        statusCode: 409
      });
    }
    return asset;
  }

  async validateRunRequest(request) {
    const referenced = referencedAssets(request?.messages);
    if (referenced.legacy) {
      throw assetError(
        "This image exists only in the originating browser; reinsert it to upload it to Runtime",
        {
          code: "ASSET_LEGACY_BROWSER_ONLY",
          statusCode: 422
        }
      );
    }
    if (referenced.invalid) {
      throw assetError("Asset reference is invalid", {
        code: "ASSET_REFERENCE_INVALID",
        statusCode: 422
      });
    }
    for (const assetId of referenced.ids) {
      await this.requireReady(assetId);
    }
  }

  hasRunReferences(request) {
    const referenced = referencedAssets(request?.messages);
    return referenced.legacy || referenced.invalid || referenced.ids.length > 0;
  }

  async openRead(assetId, range = null) {
    const asset = await this.requireReady(assetId);
    return {
      asset,
      ...await this.blobs.openRead(asset.blobKey, range)
    };
  }

  async readDataUrl(assetId, { maxBytes = this.maxImageBytes } = {}) {
    const asset = await this.requireReady(assetId);
    if (asset.byteLength > maxBytes) {
      throw assetError(`Asset exceeds materialization limit of ${maxBytes} bytes`, {
        code: "MEDIA_PROVIDER_LIMIT_EXCEEDED",
        statusCode: 413,
        limitBytes: maxBytes
      });
    }
    const content = await this.blobs.openRead(asset.blobKey);
    const chunks = [];
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
    return `data:${asset.mediaType};base64,${Buffer.concat(chunks).toString("base64")}`;
  }
}
