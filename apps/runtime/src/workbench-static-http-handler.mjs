import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

const WORKBENCH_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://auth.zioon.tech",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-eval' blob: https://auth.zioon.tech",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:"
].join("; ");

function isInside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function responseHeaders(path) {
  const extension = extname(path).toLowerCase();
  const immutable = path.includes("/assets/");
  return {
    "content-type": CONTENT_TYPES.get(extension) || "application/octet-stream",
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "content-security-policy": WORKBENCH_CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  };
}

export async function createWorkbenchStaticHttpHandler({
  root,
  spaMounts = [{ pathname: "/mobile", directory: "mobile" }],
  followReleasePointer = true
} = {}) {
  const configuredRoot = String(root || "").trim();
  if (!configuredRoot) {
    throw new Error("Workbench static root is required");
  }
  const staticRoot = await realpath(resolve(configuredRoot));
  if (followReleasePointer) {
    let loadedRoot = staticRoot;
    let handler = await createWorkbenchStaticHttpHandler({ root: loadedRoot, spaMounts, followReleasePointer: false });
    return async (...args) => {
      const currentRoot = await realpath(resolve(configuredRoot));
      if (currentRoot !== loadedRoot) {
        handler = await createWorkbenchStaticHttpHandler({ root: currentRoot, spaMounts, followReleasePointer: false });
        loadedRoot = currentRoot;
      }
      return handler(...args);
    };
  }
  const indexPath = await existingFile(resolve(staticRoot, "index.html"));
  if (!indexPath) {
    throw new Error(`Workbench index.html not found in ${staticRoot}`);
  }
  const nestedSpaMounts = [];
  for (const input of Array.isArray(spaMounts) ? spaMounts : []) {
    const pathname = `/${String(input?.pathname || "").replace(/^\/+|\/+$/g, "")}`;
    const directory = String(input?.directory || "").replace(/^\/+|\/+$/g, "");
    if (pathname === "/" || !directory) continue;
    const nestedRoot = resolve(staticRoot, directory);
    if (!isInside(staticRoot, nestedRoot)) continue;
    const nestedIndex = await existingFile(resolve(nestedRoot, "index.html"));
    if (!nestedIndex) continue;
    nestedSpaMounts.push({
      pathname,
      indexPath: nestedIndex
    });
  }

  return async function handleWorkbenchStatic(request, response, url) {
    if (
      !["GET", "HEAD"].includes(String(request.method || "GET"))
      || url.pathname === "/health"
      || url.pathname.startsWith("/v1/")
    ) {
      return false;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, { "cache-control": "no-store" });
      response.end();
      return true;
    }
    const nestedSpa = nestedSpaMounts.find((mount) => (
      decodedPath === mount.pathname
      || decodedPath.startsWith(`${mount.pathname}/`)
    ));
    if (nestedSpa && decodedPath === nestedSpa.pathname) {
      response.writeHead(308, {
        location: `${nestedSpa.pathname}/${url.search}`,
        "cache-control": "no-store"
      });
      response.end();
      return true;
    }
    const requested = resolve(staticRoot, `.${decodedPath}`);
    if (!isInside(staticRoot, requested)) {
      response.writeHead(403, { "cache-control": "no-store" });
      response.end();
      return true;
    }

    let filePath = await existingFile(requested);
    if (!filePath) {
      if (decodedPath.startsWith("/assets/") || extname(decodedPath)) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return true;
      }
      filePath = nestedSpa?.indexPath || indexPath;
    }
    const canonicalPath = await realpath(filePath);
    if (!isInside(staticRoot, canonicalPath)) {
      response.writeHead(403, { "cache-control": "no-store" });
      response.end();
      return true;
    }
    const metadata = await stat(canonicalPath);
    response.writeHead(200, {
      ...responseHeaders(canonicalPath),
      "content-length": metadata.size
    });
    if (request.method === "HEAD") {
      response.end();
      return true;
    }
    const stream = createReadStream(canonicalPath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return true;
  };
}
