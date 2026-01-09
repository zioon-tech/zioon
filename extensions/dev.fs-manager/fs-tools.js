/**
 * dev.fs-manager: fs tools for LLM
 * - Registers FS-related tools into chat.tools and handlers into chat.toolHandlers
 * - Tools: fsEntries, fsTree, fsRead, fsWrite, fsEdit
 */
export function registerFsTools() {
  try {
    /* ===== Helpers (integrate with fs-manager state) ===== */
    function getAllowedEntries() {
      const arr = window.zion?.state?.get("fs.allowed");
      return Array.isArray(arr) ? arr : [];
    }
    function segmentsFromPath(p) {
      return String(p || "").replace(/\\/g, "/").split("/").filter(Boolean);
    }
    function basenameFromPath(p) {
      const segs = segmentsFromPath(p);
      return segs[segs.length - 1] || "";
    }
    function normalizeFsPath(p) {
      return String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/").trim();
    }
    function normKey(entry, rel) {
      const id = entry?.id ? String(entry.id) : "unknown";
      const tail = rel ? `/${rel}` : "";
      return `handle://${id}${tail}`;
    }
    async function ensureFsPermission(handle, mode = "read") {
      try {
        const q = await handle.queryPermission?.({ mode }) ?? "granted";
        if (q === "granted") return true;
        const r = await handle.requestPermission?.({ mode }) ?? "denied";
        return r === "granted";
      } catch {
        return true;
      }
    }
    async function traverseToFile(dirHandle, relPath) {
      const parts = segmentsFromPath(relPath);
      if (parts.length === 0) return null;
      let dir = dirHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        try {
          dir = await dir.getDirectoryHandle(parts[i], { create: false });
        } catch {
          return null;
        }
      }
      try {
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: false });
        return fh;
      } catch {
        return null;
      }
    }
    async function resolveFileHandleFromPath(filePath) {
      const allowed = getAllowedEntries();
      const sRaw = String(filePath || "").trim();
      const s = normalizeFsPath(sRaw);
      if (!s) return null;

      // Absolute path mapping via configured entry.path
      for (const entry of allowed) {
        const baseAbs = normalizeFsPath(entry.path || "");
        if (!baseAbs) continue;
        if (entry.kind === "file") {
          if (s === baseAbs) {
            return { handle: entry.handle, key: normKey(entry, "") };
          }
        } else if (entry.kind === "directory") {
          if (s === baseAbs || s.startsWith(baseAbs + "/")) {
            const rel = s.slice(baseAbs.length).replace(/^\/+/, "");
            if (!rel) return null;
            const fh = await traverseToFile(entry.handle, rel);
            if (!fh) return null;
            return { handle: fh, key: normKey(entry, rel) };
          }
        }
      }

      // Scheme: handle://<id>/relative
      if (s.startsWith("handle://")) {
        const raw = s.slice("handle://".length);
        const idx = raw.indexOf("/");
        const id = idx >= 0 ? raw.slice(0, idx) : raw;
        const rel = idx >= 0 ? raw.slice(idx + 1) : "";
        const entry = allowed.find(e => String(e.id) === id);
        if (!entry) return null;
        if (entry.kind === "file") {
          return { handle: entry.handle, key: normKey(entry, "") };
        } else if (entry.kind === "directory") {
          if (!rel) return null;
          const fh = await traverseToFile(entry.handle, rel);
          if (!fh) return null;
          return { handle: fh, key: normKey(entry, rel) };
        }
        return null;
      }

      // Fallback: match by file name in allowed files
      const base = basenameFromPath(s);
      const fileEntry = allowed.find(e => e.kind === "file" && e.name === base);
      if (fileEntry) {
        return { handle: fileEntry.handle, key: normKey(fileEntry, "") };
      }

      // Fallback: try within any allowed directory by finding the directory name segment
      for (const entry of allowed) {
        if (entry.kind !== "directory") continue;
        const segs = segmentsFromPath(s);
        const idx = segs.findIndex(seg => seg === entry.name);
        if (idx >= 0) {
          const rel = segs.slice(idx + 1).join("/");
          if (!rel) continue;
          const fh = await traverseToFile(entry.handle, rel);
          if (fh) return { handle: fh, key: normKey(entry, rel) };
        }
      }

      return null;
    }

    // Resolve for write (allow creating new files)
    async function resolveFileHandleForWrite(filePath) {
      const resolved = await resolveFileHandleFromPath(filePath);
      if (resolved?.handle) return { ...resolved, isNewFile: false };

      const allowed = getAllowedEntries();
      const sRaw = String(filePath || "").trim();
      const s = normalizeFsPath(sRaw);
      if (!s) return null;

      // Absolute path -> within allowed directory (using configured entry.path)
      for (const entry of allowed) {
        if (entry.kind !== "directory") continue;
        const baseAbs = normalizeFsPath(entry.path || "");
        if (baseAbs && (s === baseAbs || s.startsWith(baseAbs + "/"))) {
          const rel = s.slice(baseAbs.length).replace(/^\/+/, "");
          if (!rel) return null;
          const segs = segmentsFromPath(rel);
          if (segs.length === 0) return null;
          let dir = entry.handle;
          for (let i = 0; i < segs.length - 1; i++) {
            try { dir = await dir.getDirectoryHandle(segs[i], { create: true }); } catch { return null; }
          }
          try {
            const fileHandle = await dir.getFileHandle(segs[segs.length - 1], { create: true });
            return { handle: fileHandle, key: normKey(entry, rel), isNewFile: true };
          } catch { return null; }
        }
      }

      // handle:// scheme
      if (s.startsWith("handle://")) {
        const raw = s.slice("handle://".length);
        const idx = raw.indexOf("/");
        const id = idx >= 0 ? raw.slice(0, idx) : raw;
        const rel = idx >= 0 ? raw.slice(idx + 1) : "";
        const entry = allowed.find(e => String(e.id) === id);
        if (!entry || entry.kind !== "directory" || !rel) return null;
        const segs = segmentsFromPath(rel);
        if (segs.length === 0) return null;
        let dir = entry.handle;
        for (let i = 0; i < segs.length - 1; i++) {
          try { dir = await dir.getDirectoryHandle(segs[i], { create: true }); } catch { return null; }
        }
        try {
          const fileHandle = await dir.getFileHandle(segs[segs.length - 1], { create: true });
          return { handle: fileHandle, key: normKey(entry, rel), isNewFile: true };
        } catch { return null; }
      }

      // Name-based fallback within allowed directories
      for (const entry of allowed) {
        if (entry.kind !== "directory") continue;
        const segs = segmentsFromPath(s);
        const idx = segs.findIndex(seg => seg === entry.name);
        if (idx >= 0) {
          const rel = segs.slice(idx + 1).join("/");
          if (!rel) continue;
          let dir = entry.handle;
          if (segs.length - idx > 1) {
            for (let i = idx + 1; i < segs.length - 1; i++) {
              try { dir = await dir.getDirectoryHandle(segs[i], { create: true }); } catch { return null; }
            }
          }
          try {
            const fileHandle = await dir.getFileHandle(segs[segs.length - 1], { create: true });
            return { handle: fileHandle, key: normKey(entry, rel), isNewFile: true };
          } catch { return null; }
        }
      }
      return null;
    }

    async function readFileText(handle) {
      const f = await handle.getFile();
      return await f.text();
    }
    function catFormat(text, offset, limit) {
      const lines = String(text || "").replace(/\r/g, "").split("\n");
      const startIdx = Math.max(0, (typeof offset === "number" && offset > 0 ? offset - 1 : 0));
      const endIdx = typeof limit === "number" && limit > 0 ? Math.min(lines.length, startIdx + limit) : lines.length;
      const pad = (n) => String(n).padStart(6, " ");
      let out = "";
      for (let i = startIdx; i < endIdx; i++) {
        out += `${pad(i + 1)}\t${lines[i]}\n`;
      }
      return out;
    }
    function countOccurrences(haystack, needle) {
      if (!needle) return 0;
      let count = 0;
      let pos = 0;
      while (true) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;
        count++;
        pos = idx + needle.length;
      }
      return count;
    }

    /* ===== Tools definitions ===== */
    const tools = [
      {
        type: "function",
        function: {
          name: "fsEntries",
          description: "List accessible entries from fs-manager (files and directories).",
          parameters: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["file", "directory"], description: "Filter by kind (optional)" }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fsRead",
          description: "Read a file via File System Access (requires prior permission via fs-manager). Returns content in cat -n format with line numbers.",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Absolute path" },
              offset: { type: "number", description: "The line number to start reading from (1-based, optional)" },
              limit: { type: "number", description: "The number of lines to read (optional)" }
            },
            required: ["file_path"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fsWrite",
          description: "Overwrite a file's contents. You MUST read the file at least once before writing. Supports creating new files under allowed directories.",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Absolute path" },
              content: { type: "string", description: "The content to write to the file" }
            },
            required: ["file_path", "content"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fsEdit",
          description: "Perform exact string replacements in an existing file. You MUST read the file at least once before editing.",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Absolute path" },
              old_string: { type: "string", description: "The exact text to replace (must uniquely match unless replace_all is true)" },
              new_string: { type: "string", description: "The replacement text (must be different from old_string)" },
              replace_all: { type: "boolean", description: "Replace all occurrences of old_string across the file (default false)" }
            },
            required: ["file_path", "old_string", "new_string"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fsTree",
          description: "Get directory tree structure (up to 3 levels deep, excluding common ignored folders like .git, node_modules, etc.)",
          parameters: {
            type: "object",
            properties: {
              directory_path: { type: "string", description: "Directory path" },
              max_depth: { type: "number", description: "Maximum depth to traverse (default: 3)" }
            },
            required: ["directory_path"],
            additionalProperties: false
          }
        }
      }
    ];

    // Merge tools into chat.tools
    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    for (const t of tools) {
      const nm = t?.function?.name;
      if (nm && !existNames.has(nm)) merged.push(t);
    }
    window.zion?.state?.set("chat.tools", merged);

    /* ===== Handlers ===== */
    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };

    // fsEntries
    handlers.fsEntries = async (args) => {
      try {
        const kind = String(args?.kind || "").trim();
        const list = getAllowedEntries().map(e => ({ id: e.id, kind: e.kind, name: e.name, path: e.path || "" }));
        const filtered = kind ? list.filter(it => it.kind === kind) : list;
        return JSON.stringify(filtered, null, 2);
      } catch (e) {
        return `fsEntries error: ${e?.message || String(e)}`;
      }
    };

    // fsRead
    handlers.fsRead = async (args) => {
      const filePath = String(args?.file_path || "").trim();
      if (!filePath) return "Missing file_path";
      try {
        const resolved = await resolveFileHandleFromPath(filePath);
        if (!resolved?.handle) return "File not accessible. Please grant access via fs-manager first.";
        const ok = await ensureFsPermission(resolved.handle, "read");
        if (!ok) return "Permission denied to read this file.";
        const text = await readFileText(resolved.handle);
        const s = catFormat(text, args?.offset, args?.limit);

        // Track read files in session state
        const prev = window.zion?.state?.get("fs.lastReadPaths");
        const arr = Array.isArray(prev) ? prev.slice() : [];
        if (!arr.includes(resolved.key)) arr.push(resolved.key);
        window.zion?.state?.set("fs.lastReadPaths", arr);

        return s;
      } catch (e) {
        return `Read error: ${e?.message || String(e)}`;
      }
    };

    // fsWrite
    handlers.fsWrite = async (args) => {
      const filePath = String(args?.file_path || "").trim();
      const content = String(args?.content ?? "");
      if (!filePath) return "Missing file_path";
      try {
        const resolved = await resolveFileHandleForWrite(filePath);
        if (!resolved?.handle) return "File not accessible. Please grant access via fs-manager first.";
        if (!resolved.isNewFile) {
          const readList = window.zion?.state?.get("fs.lastReadPaths");
          if (!Array.isArray(readList) || !readList.includes(resolved.key)) {
            return "Write blocked: you must read this file first (use fsRead).";
          }
        }
        const ok = await ensureFsPermission(resolved.handle, "readwrite");
        if (!ok) return "Permission denied to write this file.";
        const w = await resolved.handle.createWritable();
        await w.write(content);
        await w.close();
        if (resolved.isNewFile) {
          const prev = window.zion?.state?.get("fs.lastReadPaths");
          const arr = Array.isArray(prev) ? prev.slice() : [];
          if (!arr.includes(resolved.key)) arr.push(resolved.key);
          window.zion?.state?.set("fs.lastReadPaths", arr);
        }
        return `Write OK: ${content.length} bytes -> ${resolved.key}`;
      } catch (e) {
        return `Write error: ${e?.message || String(e)}`;
      }
    };

    // fsEdit
    handlers.fsEdit = async (args) => {
      const filePath = String(args?.file_path || "").trim();
      const oldStr = String(args?.old_string ?? "");
      const newStr = String(args?.new_string ?? "");
      const replaceAll = Boolean(args?.replace_all);
      if (!filePath) return "Missing file_path";
      if (!oldStr) return "Missing old_string";
      if (newStr === oldStr) return "new_string must be different from old_string";
      try {
        const resolved = await resolveFileHandleFromPath(filePath);
        if (!resolved?.handle) return "File not accessible. Please grant access via fs-manager first.";
        const readList = window.zion?.state?.get("fs.lastReadPaths");
        if (!Array.isArray(readList) || !readList.includes(resolved.key)) {
          return "Edit blocked: you must read this file first (use fsRead).";
        }
        const ok = await ensureFsPermission(resolved.handle, "readwrite");
        if (!ok) return "Permission denied to edit this file.";

        const text = await readFileText(resolved.handle);
        const count = countOccurrences(text, oldStr);
        if (count === 0) return "Edit failed: old_string not found in file";
        if (!replaceAll && count !== 1) {
          return "Edit failed: old_string is not unique. Provide a larger unique context or set replace_all=true.";
        }

        let updated;
        if (replaceAll) {
          updated = text.split(oldStr).join(newStr);
        } else {
          const idx = text.indexOf(oldStr);
          updated = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
        }

        const w = await resolved.handle.createWritable();
        await w.write(updated);
        await w.close();

        const changed = replaceAll ? count : 1;
        return `Edit OK: replaced ${changed} occurrence(s) in ${resolved.key}`;
      } catch (e) {
        return `Edit error: ${e?.message || String(e)}`;
      }
    };

    // fsTree
    handlers.fsTree = async (args) => {
      const dirPath = String(args?.directory_path || "").trim();
      const maxDepth = typeof args?.max_depth === "number" ? Math.max(1, Math.min(args.max_depth, 5)) : 3;
      if (!dirPath) return "Missing directory_path";
      try {
        const allowed = getAllowedEntries();
        const s = String(dirPath || "").trim();
        let dirHandle = null;
        let baseKey = "";

        if (s.startsWith("handle://")) {
          const raw = s.slice("handle://".length);
          const idx = raw.indexOf("/");
          const id = idx >= 0 ? raw.slice(0, idx) : raw;
          const rel = idx >= 0 ? raw.slice(idx + 1) : "";
          const entry = allowed.find(e => String(e.id) === id);
          if (!entry) return "Directory not accessible. Please grant access via fs-manager first.";
          if (entry.kind === "directory") {
            dirHandle = entry.handle;
            baseKey = normKey(entry, rel);
            if (rel) {
              const parts = segmentsFromPath(rel);
              let currentDir = entry.handle;
              for (const part of parts) {
                if (part) currentDir = await currentDir.getDirectoryHandle(part, { create: false });
              }
              dirHandle = currentDir;
            }
          } else {
            return "Path is not a directory";
          }
        } else {
          const segs = segmentsFromPath(s);
          if (segs.length === 0) {
            return "Directory not accessible. Please grant access via fs-manager first.";
          }

          // First try absolute path mapping via configured entry.path
          let found = false;
          const normAbs = normalizeFsPath(s);
          for (const entry of allowed) {
            if (entry.kind !== "directory") continue;
            const baseAbs = normalizeFsPath(entry.path || "");
            if (!baseAbs) continue;
            if (normAbs === baseAbs || normAbs.startsWith(baseAbs + "/")) {
              const rel = normAbs.slice(baseAbs.length).replace(/^\/+/, "");
              try {
                let currentDir = entry.handle;
                if (rel) {
                  const parts = segmentsFromPath(rel);
                  for (const part of parts) {
                    currentDir = await currentDir.getDirectoryHandle(part, { create: false });
                  }
                }
                dirHandle = currentDir;
                baseKey = normKey(entry, rel);
                found = true;
                break;
              } catch {
                continue;
              }
            }
          }

          // Fallback: match by directory name segment
          if (!found) {
            for (const entry of allowed) {
              if (entry.kind !== "directory") continue;
              const idx = segs.findIndex(seg => seg === entry.name);
              if (idx === -1) continue;
              const rel = segs.slice(idx + 1).join("/");
              try {
                let currentDir = entry.handle;
                if (rel) {
                  const parts = segmentsFromPath(rel);
                  for (const part of parts) {
                    currentDir = await currentDir.getDirectoryHandle(part, { create: false });
                  }
                }
                dirHandle = currentDir;
                baseKey = normKey(entry, rel);
                found = true;
                break;
              } catch {
                continue;
              }
            }
          }

          // Final fallback: match by base name
          if (!found) {
            const base = basenameFromPath(s);
            const dirEntry = allowed.find(e => e.kind === "directory" && e.name === base);
            if (dirEntry) {
              dirHandle = dirEntry.handle;
              baseKey = normKey(dirEntry, "");
            } else {
              return "Directory not accessible. Please grant access via fs-manager first.";
            }
          }
        }

        if (!dirHandle) return "Directory handle not found";
        const ok = await ensureFsPermission(dirHandle, "read");
        if (!ok) return "Permission denied to read this directory";

        const ignoredPatterns = [
          /^\.git$/, /^\.svn$/, /^\.hg$/,
          /^node_modules$/, /^bower_components$/, /^vendor$/, /^\.pnpm-store$/, /^\.npm$/, /^\.yarn$/,
          /^dist$/, /^build$/, /^out$/, /^target$/, /^\.next$/, /^\.nuxt$/, /^\.nuxt3$/, /^\.output$/,
          /^\.cache$/, /^\.tmp$/, /^\.temp$/, /^tmp$/, /^temp$/, /^\.parcel-cache$/, /^\.vite$/, /^\.rollup\.cache$/, /^\.eslintcache$/, /^\.stylelintcache$/,
          /^\.vscode$/, /^\.idea$/, /^\.vs$/, /^\.eclipse$/, /^\.settings$/, /^\.project$/, /^\.classpath$/, /^\.metadata$/, /^\.iml$/, /^\.ipr$/, /^\.iws$/,
          /^\.DS_Store$/, /^Thumbs\.db$/, /^desktop\.ini$/, /^\.DS_Store\?$/, /^\.AppleDouble$/, /^\.LSOverride$/, /^\.Spotlight-V100$/, /^\.Trashes$/,
          /^logs$/, /^\.log$/, /^npm-debug\.log.*$/, /^yarn-debug\.log.*$/, /^yarn-error\.log.*$/,
          /^coverage$/, /^\.nyc_output$/, /^\.coverage$/, /^htmlcov$/,
          /^\.env$/, /^\.env\..*$/, /^\.venv$/, /^venv$/, /^env$/,
          /^\.docusaurus$/, /^_site$/, /^\.jekyll-cache$/,
          /^\.webpack$/, /^stats$/,
          /^\.backup$/, /^\.old$/, /^\.bak$/, /^~$/, /^#.*#$/, /^.*~$/
        ];
        function shouldIgnore(name) {
          return ignoredPatterns.some(pattern => pattern.test(name));
        }

        async function traverseDirectory(dir, currentDepth = 0, path = "") {
          if (currentDepth >= maxDepth) {
            return { name: path || ".", type: "directory", items: null, depth: currentDepth };
          }
          const result = { name: path || ".", type: "directory", items: [], depth: currentDepth };
          try {
            for await (const [name, handle] of dir.entries()) {
              if (shouldIgnore(name)) continue;
              const item = { name, type: handle.kind };
              if (handle.kind === "directory") {
                const subDir = await traverseDirectory(handle, currentDepth + 1, name);
                item.items = subDir.items;
              } else {
                try { const file = await handle.getFile(); item.size = file.size; } catch {}
              }
              result.items.push(item);
            }
            result.items.sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          } catch { result.items = []; }
          return result;
        }

        const tree = await traverseDirectory(dirHandle);
        return JSON.stringify(tree, null, 2);
      } catch (e) {
        return `Tree error: ${e?.message || String(e)}`;
      }
    };

    window.zion?.state?.set("chat.toolHandlers", handlers);
    // enable list sync
    try {
      const known = window.zion?.state?.get("chat.toolsKnownNames") || [];
      const names = (window.zion?.state?.get("chat.tools") || []).map(t => t?.function?.name).filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);
      let enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      }
    } catch {}
  } catch (e) {
    console.warn("[fs-tools] register failed", e);
  }
}