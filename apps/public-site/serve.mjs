import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".sh": "text/plain; charset=utf-8", ".ps1": "text/plain; charset=utf-8",
  ".tgz": "application/gzip", ".gz": "application/gzip"
};

export function createSiteServer(directory = join(root, "dist")) {
  const output = resolve(directory);
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = decodeURIComponent(url.pathname);
      if (path.includes("\0") || path.includes("\\") || path.split("/").some((part, index) => part.startsWith(".") && !(index === 1 && part === ".well-known"))) {
        response.writeHead(400);
        response.end();
        return;
      }
      let file = resolve(output, `.${path}`);
      if (file !== output && !file.startsWith(output + sep)) throw new Error("Path outside output");
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        if (!path.endsWith("/")) {
          response.writeHead(308, { Location: `${url.pathname}/${url.search}` });
          response.end();
          return;
        }
        file = join(file, "index.html");
        info = await stat(file).catch(() => null);
      }
      let status = 200;
      if (!info?.isFile()) {
        file = join(output, "404.html");
        status = 404;
      }
      const actual = await realpath(file);
      if (!actual.startsWith(output + sep)) throw new Error("Symlink outside output");
      const data = await readFile(actual);
      response.writeHead(status, { "Content-Type": mime[extname(actual)] || "application/octet-stream", "Content-Length": data.length });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "Unable to serve this page.");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.ZIOON_SITE_PORT || 18868);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port");
  const server = createSiteServer();
  server.listen(port, "127.0.0.1", () => console.log(`Zioon website: http://127.0.0.1:${server.address().port}/\nDocs: http://127.0.0.1:${server.address().port}/docs/`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
