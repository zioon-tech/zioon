/**
 * dev.search-replace-plus
 * - Detects conflict blocks (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE)
 * - Renders GitHub-like diff colors for Search (delete) and Replace (add)
 * - Provides per-block toolbar: Diff | CopySearch(n) | CopyReplace(n) | Accept/Revert
 * - Adds FS integration: Accept/Revert across granted files via dev.fs-manager
 */
const I18N_NS = "dev.search-replace-plus";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.srp": "搜索替换增强",
    "cmd.acceptAll": "接受所有 Search/Replace 块",
    "cmd.revertAll": "回退所有 Search/Replace 块",
    "cmd.toggleDiffAll": "切换所有 Diff",
    "cmd.acceptAllFiles": "在已授权文件中接受",
    "cmd.revertAllFiles": "在已授权文件中回退",
    "msg.addFsFirst": "请先在 FS 面板添加文件或文件夹",
    "msg.noFiles": "未找到可处理的文件",
    "msg.filesChanged": "{action} {count} 处，影响 {files} 个文件",
    "msg.accepted": "已替换",
    "msg.reverted": "已回退",
    "msg.noItems": "无可处理项",
    "msg.fileFailed": "文件处理失败",
    "ui.permissionTitle": "需要访问权限",
    "ui.unknownPath": "未知路径",
    "ui.permissionMessage": "未授权访问目标文件：{path}",
    "ui.addFile": "添加文件",
    "ui.addFolder": "添加文件夹",
    "ui.openManager": "打开管理面板",
    "ui.cancel": "取消",
    "ui.diffOn": "Diff: 开",
    "ui.diffOff": "Diff: 关",
    "ui.toggleDiff": "切换行内 diff 颜色",
    "ui.copySearch": "复制 Search ({count})",
    "ui.copyReplace": "复制 Replace ({count})",
    "ui.copySearchAria": "复制 Search 文本",
    "ui.copyReplaceAria": "复制 Replace 文本",
    "ui.accept": "接受",
    "ui.revert": "回退",
    "ui.acceptAria": "接受替换",
    "ui.revertAria": "回退替换",
    "ui.foldSearch": "折叠/展开 Search 部分",
    "ui.foldReplace": "折叠/展开 Replace 部分",
    "msg.copiedSearch": "已复制 Search 文本",
    "msg.copiedReplace": "已复制 Replace 文本",
    "msg.tooManyMatches": "匹配过多，请检查",
    "msg.changed": "{action} {count} 处（{scope}）",
    "msg.scopeFile": "文件",
    "msg.scopeDocument": "文档",
    "msg.noAcceptItems": "无可替换项",
    "msg.noRevertItems": "无可回退项",
    "msg.fileChanged": "在文件 {path} 中{action} {count} 处",
    "msg.noMatchingFile": "未找到匹配的文件：{path}",
    "msg.noWritePermission": "目标文件未授予读写权限",
    "msg.fileReplaceFailed": "文件替换失败：{message}",
    "msg.fileRevertFailed": "文件回退失败：{message}"
  },
  "en-US": {
    "category.srp": "Search/Replace Plus",
    "cmd.acceptAll": "Accept all Search/Replace blocks",
    "cmd.revertAll": "Revert all Search/Replace blocks",
    "cmd.toggleDiffAll": "Toggle Diff (all blocks)",
    "cmd.acceptAllFiles": "Accept in granted files",
    "cmd.revertAllFiles": "Revert in granted files",
    "msg.addFsFirst": "Add files or folders in the FS panel first",
    "msg.noFiles": "No processable files found",
    "msg.filesChanged": "{action} {count} occurrences across {files} files",
    "msg.accepted": "Replaced",
    "msg.reverted": "Reverted",
    "msg.noItems": "No processable items",
    "msg.fileFailed": "File processing failed",
    "ui.permissionTitle": "Access Permission Required",
    "ui.unknownPath": "unknown path",
    "ui.permissionMessage": "Target file is not authorized: {path}",
    "ui.addFile": "Add File",
    "ui.addFolder": "Add Folder",
    "ui.openManager": "Open Manager",
    "ui.cancel": "Cancel",
    "ui.diffOn": "Diff: On",
    "ui.diffOff": "Diff: Off",
    "ui.toggleDiff": "Toggle inline diff colors",
    "ui.copySearch": "Copy Search ({count})",
    "ui.copyReplace": "Copy Replace ({count})",
    "ui.copySearchAria": "Copy Search text",
    "ui.copyReplaceAria": "Copy Replace text",
    "ui.accept": "Accept",
    "ui.revert": "Revert",
    "ui.acceptAria": "Accept replacements",
    "ui.revertAria": "Revert replacements",
    "ui.foldSearch": "Fold/unfold Search section",
    "ui.foldReplace": "Fold/unfold Replace section",
    "msg.copiedSearch": "Copied Search text",
    "msg.copiedReplace": "Copied Replace text",
    "msg.tooManyMatches": "Too many matches; please review",
    "msg.changed": "{action} {count} occurrences ({scope})",
    "msg.scopeFile": "file",
    "msg.scopeDocument": "document",
    "msg.noAcceptItems": "No replaceable items",
    "msg.noRevertItems": "No revertable items",
    "msg.fileChanged": "{action} {count} occurrences in {path}",
    "msg.noMatchingFile": "No matching file found: {path}",
    "msg.noWritePermission": "Target file has not granted read/write permission",
    "msg.fileReplaceFailed": "File replace failed: {message}",
    "msg.fileRevertFailed": "File revert failed: {message}"
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export async function activate(ctx) {
  try {
    const disp = window.zion?.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}
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
        window.showToast?.(t("msg.addFsFirst", "请先在 FS 面板添加文件或文件夹"));
        return;
      }
      const files = await listAllFilesFromEntries(entries);
      if (!files.length) {
        window.showToast?.(t("msg.noFiles", "未找到可处理的文件"));
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
        const action = kind === "accept" ? t("msg.accepted", "已替换") : t("msg.reverted", "已回退");
        window.showToast?.(t("msg.filesChanged", "{action} {count} 处，影响 {files} 个文件", { action, count: totalChanges, files: fileChanged }));
      } else {
        window.showToast?.(t("msg.noItems", "无可处理项"));
      }
    } catch (e) {
      console.error("[dev.srp] FS operation error", e);
      window.showToast?.(t("msg.fileFailed", "文件处理失败"));
    }
  }

  // Register FS commands
  window.zion.commands.registerCommand("dev.srp.acceptAllFiles", () => runAcrossFiles("accept"));
  window.zion.commands.registerCommand("dev.srp.revertAllFiles", () => runAcrossFiles("revert"));

  // Note: context menu entries removed — accept/revert is now handled by gutter-actions plugin
}
