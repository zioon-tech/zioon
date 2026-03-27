/**
 * dev.search-replace-plus
 * - Detects conflict blocks (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE)
 * - Renders GitHub-like diff colors for Search (delete) and Replace (add)
 * - Provides per-block toolbar: Diff | CopySearch(n) | CopyReplace(n) | Accept/Revert
 * - Adds FS integration: Accept/Revert across granted files via dev.fs-manager
 */
export async function activate(ctx) {
  // Polyfill a minimal toast
  if (!window.showToast) {
    window.showToast = (msg) => {
      try {
        console.info("[toast]", msg);
      } catch {}
    };
  }

  const { conflictBlocks, applyAcceptAllText, applyRevertAllText, scanBlocksInText } = await import("./diff-blocks.js");

  // Install as a decorator (injects a CM6 ViewPlugin via EditorProxy.addVisualExtension)
  const disp = window.zion.editor.registerDecorator({
    id: "dev.search-replace-plus.decorator",
    apply(editor) {
      editor.addVisualExtension(conflictBlocks());
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(disp);

  // Optional commands to operate on all blocks in current view (best-effort)
  window.zion.commands.registerCommand("dev.srp.acceptAll", () => {
    document.dispatchEvent(new CustomEvent("dev.srp/acceptAll"));
  });
  window.zion.commands.registerCommand("dev.srp.revertAll", () => {
    document.dispatchEvent(new CustomEvent("dev.srp/revertAll"));
  });
  window.zion.commands.registerCommand("dev.srp.toggleDiffAll", () => {
    document.dispatchEvent(new CustomEvent("dev.srp/toggleDiffAll"));
  });

  // FS helpers
  async function listAllFilesFromEntries(entries) {
    const out = [];
    for (const it of entries || []) {
      if (!it || !it.handle) continue;
      if (it.kind === "file") {
        out.push({ fileHandle: it.handle, path: it.name });
      } else if (it.kind === "directory") {
        const dir = it.handle;
        // traverse recursively
        try {
          for await (const [name, handle] of dir.entries()) {
            await traverse(handle, name, out);
          }
        } catch (e) {
          // older browsers: fallback to values()
          try {
            for await (const handle of dir.values()) {
              await traverse(handle, handle.name, out);
            }
          } catch {}
        }
      }
    }
    return out;

    async function traverse(handle, name, acc, prefix = "") {
      try {
        if (handle.kind === "file") {
          acc.push({ fileHandle: handle, path: (prefix ? prefix + "/" : "") + name });
        } else if (handle.kind === "directory") {
          const nextPrefix = (prefix ? prefix + "/" : "") + name;
          for await (const [childName, child] of handle.entries()) {
            await traverse(child, childName, acc, nextPrefix);
          }
        }
      } catch {}
    }
  }

  async function ensureRW(handle) {
    try {
      const q = await handle.queryPermission?.({ mode: "readwrite" }) ?? "granted";
      if (q === "granted") return true;
      const r = await handle.requestPermission?.({ mode: "readwrite" }) ?? "denied";
      return r === "granted";
    } catch {
      return true;
    }
  }

  async function runAcrossFiles(kind) {
    try {
      // read entries from fs-manager
      const entries = window.zion.commands.executeCommand("fs.getEntries");
      if (!entries || entries.length === 0) {
        window.showToast?.("请先在 FS 面板添加文件或文件夹");
        return;
      }
      const files = await listAllFilesFromEntries(entries);
      if (!files.length) {
        window.showToast?.("未找到可处理的文件");
        return;
      }
      let fileChanged = 0;
      let totalChanges = 0;

      for (const item of files) {
        const fh = item.fileHandle;
        const ok = await ensureRW(fh);
        if (!ok) continue;
        let fileObj;
        try { fileObj = await fh.getFile(); } catch { continue; }
        let text = "";
        try { text = await fileObj.text(); } catch { continue; }

        // Quick skip: no markers
        if (!text.includes("<<<<<<< SEARCH") || !text.includes(">>>>>>> REPLACE")) {
          continue;
        }
        // If no real blocks, skip
        const bs = scanBlocksInText(text);
        if (!bs || bs.length === 0) continue;

        const res = kind === "accept" ? applyAcceptAllText(text) : applyRevertAllText(text);
        if (res.changed > 0 && res.out && res.out !== text) {
          try {
            const w = await fh.createWritable();
            await w.write(res.out);
            await w.close();
            fileChanged++;
            totalChanges += res.changed;
          } catch (e) {
            console.warn("[dev.srp] write failed", item.path, e);
          }
        }
      }

      if (fileChanged > 0) {
        window.showToast?.(`${kind === "accept" ? "已替换" : "已回退"} ${totalChanges} 处，影响 ${fileChanged} 个文件`);
      } else {
        window.showToast?.("无可处理项");
      }
    } catch (e) {
      console.error("[dev.srp] FS operation error", e);
      window.showToast?.("文件处理失败");
    }
  }

  // Register FS commands
  window.zion.commands.registerCommand("dev.srp.acceptAllFiles", () => runAcrossFiles("accept"));
  window.zion.commands.registerCommand("dev.srp.revertAllFiles", () => runAcrossFiles("revert"));

  // Note: context menu entries removed — accept/revert is now handled by gutter-actions plugin
}