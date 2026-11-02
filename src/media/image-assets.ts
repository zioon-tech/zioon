import { readWorkbenchRuntimeConfig } from "../runtime/workbench-runtime-config";

export const IMAGE_ASSET_PREFIX = "zion-asset://";
export const LEGACY_IMAGE_ASSET_PREFIX = "app://img/";

const DB_NAME = "dev.paste-image-db";
const DB_VERSION = 1;
const STORE_NAME = "images";
const MAX_RESOLVED_OBJECT_URLS = 32;
const MAX_RESOLVED_OBJECT_URL_BYTES = 64 * 1024 * 1024;
const MAX_LEGACY_BROWSER_IMAGE_BYTES = 4 * 1024 * 1024;

export type ImageAssetMetadata = {
  name?: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

type ImageAssetRecord = {
  id: string;
  blob?: Blob;
  dataUrl?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  createdAt: number;
};

const resolvedObjectUrls = new Map<string, { url: string; size: number }>();
let resolvedObjectUrlBytes = 0;

function cacheObjectUrl(id: string, url: string, size: number): string {
  const previous = resolvedObjectUrls.get(id);
  if (previous) {
    resolvedObjectUrlBytes -= previous.size;
    try { URL.revokeObjectURL(previous.url); } catch {}
  }
  const boundedSize = Math.max(0, Number(size) || 0);
  resolvedObjectUrls.set(id, { url, size: boundedSize });
  resolvedObjectUrlBytes += boundedSize;
  while (
    resolvedObjectUrls.size > MAX_RESOLVED_OBJECT_URLS
    || resolvedObjectUrlBytes > MAX_RESOLVED_OBJECT_URL_BYTES
  ) {
    const oldest = resolvedObjectUrls.entries().next().value as
      | [string, { url: string; size: number }]
      | undefined;
    if (!oldest) break;
    resolvedObjectUrls.delete(oldest[0]);
    resolvedObjectUrlBytes -= oldest[1].size;
    try { URL.revokeObjectURL(oldest[1].url); } catch {}
  }
  return url;
}

function createAssetId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    }
  } catch {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function runtimeAssetId(source: string): string | null {
  if (!source.startsWith(IMAGE_ASSET_PREFIX)) return null;
  const id = source.slice(IMAGE_ASSET_PREFIX.length);
  return /^[a-zA-Z0-9._:-]{1,200}$/.test(id) ? id : null;
}

function runtimeAssetEndpoint(source: string, suffix = ""): string | null {
  const id = runtimeAssetId(source);
  if (!id) return null;
  const runtime = readWorkbenchRuntimeConfig();
  if (runtime.mode === "browser") return null;
  return `${runtime.baseUrl}/v1/assets/${encodeURIComponent(id)}${suffix}`;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  const error = new Error(body?.error || `${fallback}: HTTP ${response.status}`);
  if (body?.code) (error as Error & { code?: string }).code = String(body.code);
  return error;
}

async function uploadRuntimeImage(
  blob: Blob,
  metadata: ImageAssetMetadata
): Promise<string | null> {
  const runtime = readWorkbenchRuntimeConfig();
  if (runtime.mode === "browser") return null;
  const response = await fetch(`${runtime.baseUrl}/v1/assets`, {
    method: "POST",
    headers: {
      "content-type": metadata.mimeType || blob.type || "application/octet-stream",
      ...(metadata.name
        ? { "x-zion-file-name": encodeURIComponent(metadata.name) }
        : {})
    },
    credentials: "include",
    body: blob
  });
  if (!response.ok) {
    throw await responseError(response, "Image upload failed");
  }
  const body = await response.json().catch(() => null);
  const uri = String(body?.asset?.uri || "");
  if (!runtimeAssetId(uri)) {
    throw new Error("Runtime returned an invalid image Asset");
  }
  return uri;
}

async function readRuntimeAssetBlob(source: string): Promise<Blob | null> {
  const endpoint = runtimeAssetEndpoint(source, "/content");
  if (!endpoint) return null;
  const response = await fetch(endpoint, {
    headers: { accept: "image/*" },
    credentials: "include"
  });
  if (!response.ok) return null;
  return await response.blob();
}

function openImageAssetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open image asset database"));
    } catch (error) {
      reject(error);
    }
  });
}

function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  if (!/^data:image\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9=.+-]+)*;base64,/.test(dataUrl)) {
    return Promise.reject(new Error("Image source must be a base64 data URL"));
  }
  return fetch(dataUrl).then((response) => {
    if (!response.ok) throw new Error(`Failed to decode image data: ${response.status}`);
    return response.blob();
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image asset"));
    reader.readAsDataURL(blob);
  });
}

async function readRecord(id: string): Promise<ImageAssetRecord | null> {
  if (!id) return null;
  const db = await openImageAssetDb();
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        try { db.close(); } catch {}
        resolve((request.result as ImageAssetRecord | undefined) || null);
      };
      request.onerror = () => {
        try { db.close(); } catch {}
        resolve(null);
      };
    } catch {
      try { db.close(); } catch {}
      resolve(null);
    }
  });
}

export function isImageAssetUri(value: string): boolean {
  return typeof value === "string" && (
    value.startsWith(IMAGE_ASSET_PREFIX)
    || value.startsWith(LEGACY_IMAGE_ASSET_PREFIX)
  );
}

export async function putImageAsset(
  source: Blob | string,
  metadata: ImageAssetMetadata = {}
): Promise<string> {
  const blob = typeof source === "string" ? await dataUrlToBlob(source) : source;
  const runtimeUri = await uploadRuntimeImage(blob, {
    ...metadata,
    mimeType: metadata.mimeType || blob.type
  });
  if (runtimeUri) return runtimeUri;
  if (blob.size > MAX_LEGACY_BROWSER_IMAGE_BYTES) {
    const error = new Error(
      "Browser-only image storage is limited to 4 MiB; connect Runtime to upload this image"
    ) as Error & { code?: string };
    error.code = "BROWSER_IMAGE_TOO_LARGE";
    throw error;
  }

  const id = createAssetId();
  const record: ImageAssetRecord = {
    id,
    blob,
    name: metadata.name,
    mimeType: metadata.mimeType || blob.type || "application/octet-stream",
    size: blob.size,
    width: metadata.width,
    height: metadata.height,
    createdAt: Date.now()
  };
  const db = await openImageAssetDb();
  await new Promise<void>((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Failed to store image asset"));
      transaction.onabort = () => reject(transaction.error || new Error("Image asset transaction aborted"));
    } catch (error) {
      reject(error);
    }
  }).finally(() => {
    try { db.close(); } catch {}
  });
  return `${LEGACY_IMAGE_ASSET_PREFIX}${id}`;
}

export async function resolveImageAsset(source: string): Promise<string | null> {
  if (!source) return null;
  if (!isImageAssetUri(source)) return source;
  const cached = resolvedObjectUrls.get(source);
  if (cached) {
    resolvedObjectUrls.delete(source);
    resolvedObjectUrls.set(source, cached);
    return cached.url;
  }
  if (source.startsWith(IMAGE_ASSET_PREFIX)) {
    const blob = await readRuntimeAssetBlob(source);
    if (!blob) return null;
    return cacheObjectUrl(source, URL.createObjectURL(blob), blob.size);
  }
  const id = source.slice(LEGACY_IMAGE_ASSET_PREFIX.length);
  const record = await readRecord(id);
  if (!record) return null;
  if (record.dataUrl) return record.dataUrl;
  if (!record.blob) return null;
  const url = URL.createObjectURL(record.blob);
  return cacheObjectUrl(source, url, record.size ?? record.blob.size);
}

export async function readImageAssetDataUrl(source: string): Promise<string | null> {
  if (!source) return null;
  if (source.startsWith("data:image/")) return source;
  if (!isImageAssetUri(source)) return null;
  if (source.startsWith(IMAGE_ASSET_PREFIX)) {
    const blob = await readRuntimeAssetBlob(source);
    return blob ? blobToDataUrl(blob) : null;
  }
  const id = source.slice(LEGACY_IMAGE_ASSET_PREFIX.length);
  const record = await readRecord(id);
  if (!record) return null;
  if (record.dataUrl) return record.dataUrl;
  return record.blob ? blobToDataUrl(record.blob) : null;
}

export async function getImageAssetMetadata(source: string): Promise<ImageAssetMetadata & {
  id: string;
  size?: number;
  createdAt?: number;
} | null> {
  if (!isImageAssetUri(source)) return null;
  if (source.startsWith(IMAGE_ASSET_PREFIX)) {
    const id = runtimeAssetId(source);
    const endpoint = runtimeAssetEndpoint(source);
    if (!id || !endpoint) return null;
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      credentials: "include"
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const asset = body?.asset;
    if (!asset) return null;
    return {
      id,
      name: asset.originalName ? String(asset.originalName) : undefined,
      mimeType: asset.mediaType ? String(asset.mediaType) : undefined,
      size: Number.isFinite(Number(asset.byteLength))
        ? Number(asset.byteLength)
        : undefined,
      createdAt: Number.isFinite(Number(asset.createdAt))
        ? Number(asset.createdAt)
        : undefined
    };
  }
  const id = source.slice(LEGACY_IMAGE_ASSET_PREFIX.length);
  const record = await readRecord(id);
  if (!record) return null;
  return {
    id,
    name: record.name,
    mimeType: record.mimeType || record.blob?.type,
    size: record.size ?? record.blob?.size,
    width: record.width,
    height: record.height,
    createdAt: record.createdAt
  };
}
