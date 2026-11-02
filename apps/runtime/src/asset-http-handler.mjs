import { Buffer } from "node:buffer";
import { pipeline } from "node:stream/promises";
import { publicAsset } from "./asset-service.mjs";

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function matchAssetPath(pathname, suffix = "") {
  const escaped = suffix.replaceAll("/", "\\/");
  const match = pathname.match(
    new RegExp(`^\\/v1\\/assets\\/([^/]+)${escaped}$`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function decodedFileName(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return "";
  }
}

function requestOwner(principal) {
  return String(
    principal?.user?.id
    || principal?.device?.deviceId
    || "runtime-local"
  );
}

function byteRange(value, byteLength) {
  if (!value) return null;
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    throw Object.assign(new Error("Asset Range header is invalid"), {
      code: "ASSET_RANGE_INVALID",
      statusCode: 416
    });
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw Object.assign(new Error("Asset Range header is invalid"), {
        code: "ASSET_RANGE_INVALID",
        statusCode: 416
      });
    }
    return {
      start: Math.max(0, byteLength - suffixLength),
      end: byteLength - 1
    };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : byteLength - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || start >= byteLength
    || end < start
  ) {
    throw Object.assign(new Error("Asset Range header is invalid"), {
      code: "ASSET_RANGE_INVALID",
      statusCode: 416
    });
  }
  return { start, end: Math.min(end, byteLength - 1) };
}

export function createAssetHttpHandler({ assets }) {
  if (!assets?.createImage || !assets?.openRead) {
    throw new Error("Asset HTTP handler requires an AssetService");
  }
  return async (request, response, url) => {
    if (request.method === "POST" && url.pathname === "/v1/assets") {
      const asset = await assets.createImage({
        stream: request,
        ownerId: requestOwner(request.zionPrincipal),
        declaredMediaType: request.headers["content-type"],
        originalName: decodedFileName(request.headers["x-zion-file-name"]),
        declaredBytes: request.headers["content-length"]
      });
      json(response, 201, { asset: publicAsset(asset) });
      return true;
    }

    const assetId = matchAssetPath(url.pathname);
    if (request.method === "GET" && assetId) {
      const asset = await assets.requireReady(assetId);
      json(response, 200, { asset: publicAsset(asset) });
      return true;
    }

    const contentAssetId = matchAssetPath(url.pathname, "/content");
    if (["GET", "HEAD"].includes(request.method) && contentAssetId) {
      const asset = await assets.requireReady(contentAssetId);
      const range = byteRange(request.headers.range, asset.byteLength);
      const headers = {
        "content-type": asset.mediaType,
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"sha256-${asset.sha256}"`
      };
      if (request.method === "HEAD") {
        response.writeHead(200, {
          ...headers,
          "content-length": asset.byteLength
        });
        response.end();
        return true;
      }
      const content = await assets.openRead(contentAssetId, range);
      if (range) {
        response.writeHead(206, {
          ...headers,
          "content-length": content.end - content.start + 1,
          "content-range": `bytes ${content.start}-${content.end}/${content.byteLength}`
        });
      } else {
        response.writeHead(200, {
          ...headers,
          "content-length": content.byteLength
        });
      }
      await pipeline(content.stream, response);
      return true;
    }

    return false;
  };
}
