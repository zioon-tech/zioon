export const IMAGE_ASSET_PREFIX = "app://img/";

const DB_NAME = "dev.paste-image-db";
const DB_VERSION = 1;
const STORE_NAME = "images";
const MAX_RESOLVED_OBJECT_URLS = 128;

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

const resolvedObjectUrls = new Map<string, string>();

function cacheObjectUrl(id: string, url: string): string {
  resolvedObjectUrls.set(id, url);
  while (resolvedObjectUrls.size > MAX_RESOLVED_OBJECT_URLS) {
    const oldest = resolvedObjectUrls.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    resolvedObjectUrls.delete(oldest[0]);
    try { URL.revokeObjectURL(oldest[1]); } catch {}
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
  return typeof value === "string" && value.startsWith(IMAGE_ASSET_PREFIX);
}

export async function putImageAsset(
  source: Blob | string,
  metadata: ImageAssetMetadata = {}
): Promise<string> {
  const blob = typeof source === "string" ? await dataUrlToBlob(source) : source;
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
  return `${IMAGE_ASSET_PREFIX}${id}`;
}

export async function resolveImageAsset(source: string): Promise<string | null> {
  if (!source) return null;
  if (!isImageAssetUri(source)) return source;
  const id = source.slice(IMAGE_ASSET_PREFIX.length);
  const cached = resolvedObjectUrls.get(id);
  if (cached) return cached;
  const record = await readRecord(id);
  if (!record) return null;
  if (record.dataUrl) return record.dataUrl;
  if (!record.blob) return null;
  const url = URL.createObjectURL(record.blob);
  return cacheObjectUrl(id, url);
}

export async function readImageAssetDataUrl(source: string): Promise<string | null> {
  if (!source) return null;
  if (source.startsWith("data:image/")) return source;
  if (!isImageAssetUri(source)) return null;
  const id = source.slice(IMAGE_ASSET_PREFIX.length);
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
  const id = source.slice(IMAGE_ASSET_PREFIX.length);
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
