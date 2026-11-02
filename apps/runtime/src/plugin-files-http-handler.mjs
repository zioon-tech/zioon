import { Buffer } from "node:buffer";

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const READ_OPERATIONS = new Set(["read", "entries", "read-jsonl"]);
const WRITE_OPERATIONS = new Set(["write", "append-jsonl"]);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Plugin file request exceeds 5 MiB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function relativePath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  if (
    !path
    || path.startsWith("/")
    || /^[A-Za-z]:\//.test(path)
    || path.split("/").some((part) => part === "..")
  ) {
    const error = new Error("Plugin file path must be relative to the plugin data directory");
    error.statusCode = 400;
    throw error;
  }
  return path;
}

function operationStatus(error) {
  if (Number.isSafeInteger(error?.statusCode)) return error.statusCode;
  const message = String(error?.message || error || "");
  if (/ENOENT|no such file|not found/i.test(message)) return 404;
  if (/content_hash_conflict|changed since|conflict|locked/i.test(message)) return 409;
  if (/outside|denied|forbidden|grant|policy/i.test(message)) return 403;
  return 500;
}

export function createPluginFilesHttpHandler({
  pluginId,
  fileService,
  withRunContext
} = {}) {
  const id = String(pluginId || "").trim();
  if (!id || !fileService?.readTextFile || !fileService?.writeTextFile
    || !fileService?.listEntries || !fileService?.readJsonlPage
    || !fileService?.appendJsonl) {
    throw new Error("Plugin files HTTP handler requires a complete file service");
  }
  if (typeof withRunContext !== "function") {
    throw new Error("Plugin files HTTP handler requires an execution context provider");
  }

  return async (request, response, url) => {
    const match = url.pathname.match(
      /^\/v1\/plugins\/([^/]+)\/files\/(read|write|entries|read-jsonl|append-jsonl)$/
    );
    if (!match || decodeURIComponent(match[1]) !== id) return false;
    const operation = match[2];
    const expectedMethod = READ_OPERATIONS.has(operation) ? "GET" : "POST";
    if (request.method !== expectedMethod) {
      json(response, 405, { error: "Method not allowed" });
      return true;
    }

    try {
      const body = WRITE_OPERATIONS.has(operation) ? await readJson(request) : {};
      const path = relativePath(
        WRITE_OPERATIONS.has(operation) ? body.path : url.searchParams.get("path")
      );
      const access = WRITE_OPERATIONS.has(operation) ? "write" : "read";
      const toolNames = operation === "entries"
        ? ["tree"]
        : operation === "append-jsonl"
          ? ["read", "write"]
          : [access === "write" ? "write" : "read"];
      const result = await withRunContext(
        request.zionPrincipal,
        { pluginId: id, access, toolNames },
        async (runContext) => {
          if (operation === "read") {
            const loaded = await fileService.readTextFile({
              relativePath: path,
              runContext
            });
            if (loaded.missing) {
              const error = new Error("ENOENT: no such file");
              error.statusCode = 404;
              throw error;
            }
            return {
              ok: true,
              path: loaded.path,
              content: loaded.content,
              content_hash: loaded.contentHash
            };
          }
          if (operation === "write") {
            const written = await fileService.writeTextFile({
              relativePath: path,
              content: String(body.content ?? ""),
              ...(Object.hasOwn(body, "expected_hash")
                ? { expectedHash: body.expected_hash }
                : {}),
              createOnly: body.create_only === true,
              runContext
            });
            return {
              ok: true,
              path: written.path,
              content_hash: written.contentHash,
              written: written.written,
              ...(written.created !== undefined ? { created: written.created } : {})
            };
          }
          if (operation === "entries") {
            const listed = await fileService.listEntries({
              relativePath: path,
              runContext
            });
            if (listed.missing) {
              const error = new Error("ENOENT: no such directory");
              error.statusCode = 404;
              throw error;
            }
            return {
              ok: true,
              path: listed.path,
              entries: listed.entries
            };
          }
          if (operation === "read-jsonl") {
            const page = await fileService.readJsonlPage({
              relativePath: path,
              offset: url.searchParams.get("offset"),
              limit: url.searchParams.get("limit"),
              tail: url.searchParams.get("tail"),
              runContext
            });
            if (page.missing) {
              const error = new Error("ENOENT: no such file");
              error.statusCode = 404;
              throw error;
            }
            return {
              ok: true,
              path: page.path,
              content: page.content,
              content_hash: page.contentHash,
              start_line: page.startLine,
              end_line: page.endLine,
              previous_offset: page.previousOffset,
              has_previous: page.hasPrevious,
              has_more: page.hasMore
            };
          }
          return await fileService.appendJsonl({
            relativePath: path,
            records: body.records,
            runContext
          });
        }
      );
      json(response, 200, result);
    } catch (error) {
      json(response, operationStatus(error), {
        error: String(error?.message || error),
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.failureCode ? { failureCode: error.failureCode } : {})
      });
    }
    return true;
  };
}
