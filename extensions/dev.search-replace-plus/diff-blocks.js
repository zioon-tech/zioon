import { ViewPlugin, Decoration, WidgetType, gutter, GutterMarker } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { foldService, foldable, foldCode, unfoldCode } from "@codemirror/language";

/**
 * Conflict block scanner and renderer
 */

const MARKER_START = "<<<<<<< SEARCH";
const MARKER_EQ = "=======";
const MARKER_END = ">>>>>>> REPLACE";

function t(key, fallback, values) {
  const fullKey = `dev.search-replace-plus.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function countOccurrencesOutside(text, needle, excluded) {
  if (!needle) return 0;
  let cnt = 0;
  let i = 0;
  const n = text.length;
  const ex = excluded.slice().sort((a, b) => a.from - b.from);
  let exIdx = 0;
  while (i <= n - needle.length) {
    // jump over excluded ranges
    if (exIdx < ex.length && i >= ex[exIdx].from) {
      if (i < ex[exIdx].to) {
        i = ex[exIdx].to;
        exIdx++;
        continue;
      } else {
        exIdx++;
      }
    }
    if (text.startsWith(needle, i)) {
      cnt++;
      i += needle.length || 1;
    } else {
      i++;
    }
  }
  return cnt;
}

function replaceOutside(text, needle, repl, excluded) {
  if (!needle) return { out: text, count: 0 };
  const n = text.length;
  const ex = excluded.slice().sort((a, b) => a.from - b.from);
  let exIdx = 0;
  let i = 0;
  let count = 0;
  let out = "";
  while (i < n) {
    if (exIdx < ex.length && i >= ex[exIdx].from) {
      // copy excluded segment as-is
      const segEnd = ex[exIdx].to;
      out += text.slice(i, segEnd);
      i = segEnd;
      exIdx++;
      continue;
    }
    if (i <= n - needle.length && text.startsWith(needle, i)) {
      out += repl;
      i += needle.length;
      count++;
    } else {
      out += text[i];
      i++;
    }
  }
  return { out, count };
}

function lineAt(doc, pos) {
  return doc.lineAt ? doc.lineAt(pos) : doc.line(pos);
}

/* ===== Pure-text helpers for FS operations ===== */

/** Scan conflict blocks in a plain string. Returns blocks with absolute offsets. */
export function scanBlocksInText(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === MARKER_START) {
      let eq = -1, end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === MARKER_EQ && eq === -1) eq = j;
        if (t === MARKER_END) { end = j; break; }
      }
      if (eq !== -1 && end !== -1) {
        // Compute absolute offsets
        const startLine = i;
        const startFrom = offset;
        // compute line from/to offsets
        const lineFrom = (ln) => {
          // sum lengths up to ln
          let off = 0;
          for (let k = 0; k < ln; k++) off += lines[k].length + 1; // +1 for '\n'
          return off;
        };
        const lineTo = (ln) => lineFrom(ln) + lines[ln].length;

        const eqFrom = lineFrom(eq);
        const endFrom = lineFrom(end);
        const searchFrom = lineFrom(startLine + 1);
        const searchTo = lineTo(Math.max(startLine + 1, eq - 1));
        const replaceFrom = lineFrom(eq + 1);
        const replaceTo = lineTo(Math.max(eq + 1, end - 1));

        const searchText = searchFrom <= searchTo ? text.slice(searchFrom, searchTo) : "";
        const replaceText = replaceFrom <= replaceTo ? text.slice(replaceFrom, replaceTo) : "";

        blocks.push({
          startLine,
          eqLine: eq,
          endLine: end,
          startFrom: lineFrom(startLine),
          eqFrom,
          endFrom,
          searchFrom,
          searchTo,
          replaceFrom,
          replaceTo,
          searchText,
          replaceText
        });

        // continue scanning after end
        i = end;
      }
    }
    offset += line.length + 1;
  }
  return blocks;
}

/** Accept all: for a given text, replace occurrences of searchText with replaceText outside conflict blocks. */
export function applyAcceptAllText(text) {
  const blocks = scanBlocksInText(text);
  const excluded = blocks.map(b => ({ from: b.startFrom, to: b.endFrom + (text[b.endFrom] === "\n" ? 0 : 0) + (text.slice(b.endFrom).indexOf("\n") === 0 ? 1 : 0) }));
  let cur = text;
  let total = 0;
  for (const b of blocks) {
    const res = replaceOutside(cur, b.searchText, b.replaceText, excluded);
    if (res.count > 0) {
      total += res.count;
      cur = res.out;
    }
  }
  return { out: cur, changed: total };
}

/** Revert all: swap directions. */
export function applyRevertAllText(text) {
  const blocks = scanBlocksInText(text);
  const excluded = blocks.map(b => ({ from: b.startFrom, to: b.endFrom + (text[b.endFrom] === "\n" ? 0 : 0) + (text.slice(b.endFrom).indexOf("\n") === 0 ? 1 : 0) }));
  let cur = text;
  let total = 0;
  for (const b of blocks) {
    const res = replaceOutside(cur, b.replaceText, b.searchText, excluded);
    if (res.count > 0) {
      total += res.count;
      cur = res.out;
    }
  }
  return { out: cur, changed: total };
}

function scanBlocks(doc) {
  const blocks = [];
  const totalLines = doc.lines;
  let ln = 1;
  while (ln <= totalLines) {
    const line = doc.line(ln);
    const txt = doc.sliceString(line.from, line.to);
    if (txt.trim() === MARKER_START) {
      // find equal and end
      let eqLine = -1;
      let endLine = -1;
      let i = ln + 1;
      while (i <= totalLines) {
        const l = doc.line(i);
        const t = doc.sliceString(l.from, l.to);
        if (t.trim() === MARKER_EQ && eqLine === -1) eqLine = i;
        if (t.trim() === MARKER_END) {
          endLine = i;
          break;
        }
        i++;
      }
      if (eqLine !== -1 && endLine !== -1) {
        // compute ranges
        const startLine = ln;
        const startFrom = doc.line(startLine).from;
        const eqFrom = doc.line(eqLine).from;
        const endFrom = doc.line(endLine).from;
        const searchFrom = doc.line(startLine + 1).from;
        const searchTo = doc.line(eqLine - 1 >= startLine + 1 ? eqLine - 1 : startLine + 1).to;
        const replaceFrom = doc.line(eqLine + 1).from;
        const replaceTo = doc.line(endLine - 1 >= eqLine + 1 ? endLine - 1 : eqLine + 1).to;

        const searchText = searchFrom <= searchTo ? doc.sliceString(searchFrom, searchTo) : "";
        const replaceText = replaceFrom <= replaceTo ? doc.sliceString(replaceFrom, replaceTo) : "";

        blocks.push({
          startLine,
          eqLine,
          endLine,
          startFrom,
          eqFrom,
          endFrom,
          searchFrom,
          searchTo,
          replaceFrom,
          replaceTo,
          searchText,
          replaceText
        });
        ln = endLine + 1;
        continue;
      }
    }
    ln++;
  }
  return blocks;
}

/* Per-block state keyed by content fingerprint */
function blockKey(b) {
  return `${b.searchText}>>>${b.replaceText}`;
}

/* Compute inline diff ranges using LCS (character-level).
   Returns ranges (half-open [from,to)) of differing segments in a(searchText) and b(replaceText). */
function computeInlineDiffRanges(a, b) {
  try {
    const m = a.length, n = b.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    // reconstruct matched pairs
    let i = m, j = n;
    const pairs = [];
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        pairs.push({ i: i - 1, j: j - 1 });
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    pairs.reverse();
    // contiguous runs of matches
    const runs = [];
    for (let k = 0; k < pairs.length;) {
      let si = pairs[k].i, sj = pairs[k].j;
      let ei = si, ej = sj;
      k++;
      while (k < pairs.length && pairs[k].i === ei + 1 && pairs[k].j === ej + 1) {
        ei = pairs[k].i;
        ej = pairs[k].j;
        k++;
      }
      // half-open end indices
      runs.push({ startA: si, endA: ei + 1, startB: sj, endB: ej + 1 });
    }
    // complement segments are the differences
    const aDiff = [];
    let prev = 0;
    for (const r of runs) {
      if (prev < r.startA) aDiff.push({ from: prev, to: r.startA });
      prev = r.endA;
    }
    if (prev < m) aDiff.push({ from: prev, to: m });

    const bDiff = [];
    prev = 0;
    for (const r of runs) {
      if (prev < r.startB) bDiff.push({ from: prev, to: r.startB });
      prev = r.endB;
    }
    if (prev < n) bDiff.push({ from: prev, to: n });

    return { aDiff, bDiff };
  } catch {
    return {
      aDiff: a ? [{ from: 0, to: a.length }] : [],
      bDiff: b ? [{ from: 0, to: b.length }] : []
    };
  }
}

/* ===== Path & FS helpers for per-block operations ===== */

/** Try to extract a file path from up to 3 lines above the block start line.
    Supports: raw absolute path (/Users/...) and backticked path (`/Users/...`). */
function findFilePathAboveBlock(doc, block) {
  const tryExtract = (s) => {
    let t = (s || "").trim();
    if (!t) return null;
    if (/^```/.test(t)) return null; // fence line, skip
    // backticked path
    const bt = /^`([^`]+)`$/.exec(t);
    if (bt && bt[1]?.startsWith("/")) return bt[1];
    // raw absolute path
    if (t.startsWith("/")) return t;
    return null;
  };
  for (let off = 1; off <= 3; off++) {
    const lnNum = block.startLine - off;
    if (lnNum < 1) break;
    const l = doc.line(lnNum);
    const text = doc.sliceString(l.from, l.to);
    const p = tryExtract(text);
    if (p) return p;
    // allow skipping empty line
    if (text.trim() === "") continue;
  }
  return null;
}

/** Ensure read-write permission on a handle (best-effort) */
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

/** Traverse all files from fs-manager entries (files/directories) */
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

/** Prompt user to authorize FS access (add file/folder). Returns true if file likely available after action. */
function requestFSAuthorization(targetPath) {
  return new Promise((resolve) => {
    try {
      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.35)";
      overlay.style.zIndex = "99998";
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };

      const panel = document.createElement("div");
      panel.style.position = "fixed";
      panel.style.right = "24px";
      panel.style.top = "72px";
      panel.style.width = "360px";
      panel.style.background = "var(--panel)";
      panel.style.border = "1px solid var(--border)";
      panel.style.borderRadius = "6px";
      panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
      panel.style.padding = "12px";
      panel.style.color = "var(--fg)";
      panel.style.zIndex = "99999";
      panel.onclick = (e) => e.stopPropagation();

      const title = document.createElement("div");
      title.textContent = t("ui.permissionTitle", "需要访问权限");
      title.style.fontWeight = "600";
      title.style.marginBottom = "6px";

      const msg = document.createElement("div");
      msg.style.fontSize = "12px";
      msg.style.opacity = "0.9";
      msg.textContent = t("ui.permissionMessage", "未授权访问目标文件：{path}", { path: targetPath || `(${t("ui.unknownPath", "未知路径")})` });

      const btns = document.createElement("div");
      btns.style.display = "flex";
      btns.style.gap = "6px";
      btns.style.marginTop = "10px";

      const mkBtn = (label, onClick) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.background = "var(--border)";
        b.style.color = "var(--fg)";
        b.style.border = "1px solid var(--accent)";
        b.style.borderRadius = "4px";
        b.style.padding = "4px 8px";
        b.onclick = onClick;
        return b;
      };

      const refreshAndCheck = async () => {
        try {
          const entries = await window.zion.commands.executeCommand("fs.getEntries");
          if (!entries || entries.length === 0) return false;
          const files = await listAllFilesFromEntries(entries);
          const picked = pickBestFile(files, targetPath);
          return !!picked;
        } catch { return false; }
      };

      const addFileBtn = mkBtn(t("ui.addFile", "添加文件"), async () => {
        try { await window.zion.commands.executeCommand("fs.addFile"); } catch {}
        const ok = await refreshAndCheck();
        cleanup(ok);
      });
      const addFolderBtn = mkBtn(t("ui.addFolder", "添加文件夹"), async () => {
        try { await window.zion.commands.executeCommand("fs.addFolder"); } catch {}
        const ok = await refreshAndCheck();
        cleanup(ok);
      });
      const openMgrBtn = mkBtn(t("ui.openManager", "打开管理面板"), () => {
        try { window.zion.commands.executeCommand("fs.showManager"); } catch {}
      });
      const cancelBtn = mkBtn(t("ui.cancel", "取消"), () => cleanup(false));

      btns.append(addFileBtn, addFolderBtn, openMgrBtn, cancelBtn);
      panel.append(title, msg, btns);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      function cleanup(result) {
        try { overlay.remove(); } catch {}
        resolve(!!result);
      }
    } catch {
      resolve(false);
    }
  });
}

/** Pick best match file from list for an absolute or relative path */
function pickBestFile(files, targetPath) {
  if (!Array.isArray(files) || !targetPath) return null;
  const basename = targetPath.split("/").filter(Boolean).pop();
  let best = null;
  let bestScore = -1;
  for (const f of files) {
    const cand = String(f.path || "");
    let score = -1;
    if (cand === targetPath) score = cand.length + 1000;           // exact
    else if (targetPath.endsWith("/" + cand)) score = cand.length + 500; // suffix match
    else if (cand.endsWith("/" + basename) || cand === basename) score = (basename?.length || 0);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best;
}

/** Single replace outside conflict blocks in plain text */
function applyOneReplaceText(text, searchText, replaceText) {
  const blocks = scanBlocksInText(text);
  const excluded = blocks.map(b => ({ from: b.startFrom, to: lineAt({ lineAt: (p) => {
    // minimal lineAt polyfill for plain string: compute line end at endFrom line
    const s = text.slice(0, b.endFrom);
    const ln = s.lastIndexOf("\n");
    const from = ln + 1;
    const to = b.endFrom + (text[b.endFrom] === "\n" ? 0 : 0);
    return { from, to };
  } }, b.endFrom).to }));
  return replaceOutside(text, searchText, replaceText, excluded);
}

/* ===== Toolbar Widget (with FS-aware Accept/Revert) ===== */
class ToolbarWidget extends WidgetType {
  constructor(block, getState, setState, applyReplace, applyRevert, getCounts, applyReplaceFile, applyRevertFile, computeCountsInFile) {
    super();
    this.block = block;
    this.getState = getState;
    this.setState = setState;
    this.applyReplace = applyReplace;
    this.applyRevert = applyRevert;
    this.getCounts = getCounts;
    this.applyReplaceFile = applyReplaceFile;
    this.applyRevertFile = applyRevertFile;
    this.computeCountsInFile = computeCountsInFile;
  }
  eq(other) {
    const a = this.getState(blockKey(this.block));
    const b = other.getState(blockKey(other.block));
    return (
      this.block.searchFrom === other.block.searchFrom &&
      this.block.searchTo === other.block.searchTo &&
      this.block.replaceFrom === other.block.replaceFrom &&
      this.block.replaceTo === other.block.replaceTo &&
      a?.diff === b?.diff && a?.applied === b?.applied
    );
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "srp-toolbar";
    wrap.setAttribute("role", "toolbar");
    wrap.style.display = "flex";
    wrap.style.gap = "6px";
    wrap.style.alignItems = "center";
    wrap.style.padding = "8px 8px 4px 0px";
    wrap.style.position = "relative";
    wrap.style.zIndex = "10";

    const state = this.getState(blockKey(this.block)) || { diff: false, applied: false, fsCounts: null };

    const mkBtn = (label, aria, onClick) => {
      const b = document.createElement("button");
      b.className = "srp-btn";
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-label", aria || label);
      b.style.background = "transparent";
      b.style.color = "var(--fg)";
      b.style.border = "1px solid var(--border)";
      b.style.borderRadius = "4px";
      b.style.fontSize = "12px";
      b.style.padding = "2px 6px";
      b.style.cursor = "pointer";
      b.onmouseenter = () => (b.style.background = "var(--border)");
      b.onmouseleave = () => (b.style.background = "transparent");
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { onClick(); } catch {}
      };
      return b;
    };

    const initialCounts = this.getCounts(this.block); // fallback (document counts or cached file counts)
    const diffBtn = mkBtn(state.diff ? t("ui.diffOn", "Diff: On") : t("ui.diffOff", "Diff: Off"), t("ui.toggleDiff", "Toggle inline diff colors"), () => {
      const st = this.getState(blockKey(this.block)) || { diff: false, applied: false };
      st.diff = !st.diff;
      this.setState(blockKey(this.block), st);
      document.dispatchEvent(new CustomEvent("dev.srp/refresh"));
    });

    const copyS = mkBtn(t("ui.copySearch", "Copy Search ({count})", { count: initialCounts.searchMatches }), t("ui.copySearchAria", "Copy Search text"), async () => {
      try { await navigator.clipboard.writeText(this.block.searchText); window.showToast?.(t("msg.copiedSearch", "已复制 Search 文本")); } catch {}
      // After copy, compute file counts and adjust AR intent: Accept if search>=1
      await updateCountsFromFile();
      const st = this.getState(blockKey(this.block)) || { diff: false, applied: false };
      if (st.fsCounts && st.fsCounts.searchMatches >= 1) {
        st.applied = false; // next action: Accept
        this.setState(blockKey(this.block), st);
        arBtn.textContent = t("ui.accept", "Accept");
        arBtn.setAttribute("aria-label", t("ui.acceptAria", "Accept replacements"));
      }
    });
    const copyR = mkBtn(t("ui.copyReplace", "Copy Replace ({count})", { count: initialCounts.replaceMatches }), t("ui.copyReplaceAria", "Copy Replace text"), async () => {
      try { await navigator.clipboard.writeText(this.block.replaceText); window.showToast?.(t("msg.copiedReplace", "已复制 Replace 文本")); } catch {}
      // After copy, compute file counts and adjust AR intent: Revert if replace>=1
      await updateCountsFromFile();
      const st = this.getState(blockKey(this.block)) || { diff: false, applied: false };
      if (st.fsCounts && st.fsCounts.replaceMatches >= 1) {
        st.applied = true; // next action: Revert
        this.setState(blockKey(this.block), st);
        arBtn.textContent = t("ui.revert", "Revert");
        arBtn.setAttribute("aria-label", t("ui.revertAria", "Revert replacements"));
      }
    });

    const arBtn = mkBtn(state.applied ? t("ui.revert", "Revert") : t("ui.accept", "Accept"), state.applied ? t("ui.revertAria", "Revert replacements") : t("ui.acceptAria", "Accept replacements"), async () => {
      const st = this.getState(blockKey(this.block)) || { diff: false, applied: false };
      // 获取最新计数（优先文件计数，否则文档计数）
      const counts = this.getCounts(this.block);
      if (!st.applied) {
        // Accept operation
        if (counts && counts.searchMatches > 5) {
          window.showToast?.(t("msg.tooManyMatches", "匹配过多，请检查"));
        }
        
        let changed = 0;
        let operationType = "";
        
        // Try FS-targeted accept first
        try { 
          changed = await this.applyReplaceFile(this.block); 
          operationType = t("msg.scopeFile", "文件");
        } catch (e) {
          console.warn("[dev.srp] FS accept failed, falling back to document", e);
        }
        
        // If FS operation didn't change anything, fallback to current doc
        if (changed === 0) {
          try {
            changed = await this.applyReplace(this.block);
            operationType = t("msg.scopeDocument", "文档");
          } catch (e) {
            console.error("[dev.srp] Document accept failed", e);
          }
        }
        
        if (changed > 0) {
          st.applied = true;
          this.setState(blockKey(this.block), st);
          window.showToast?.(t("msg.changed", "{action} {count} 处（{scope}）", { action: t("msg.accepted", "已替换"), count: changed, scope: operationType }));
          // Update button text immediately
          arBtn.textContent = t("ui.revert", "Revert");
          arBtn.setAttribute("aria-label", t("ui.revertAria", "Revert replacements"));
        } else {
          window.showToast?.(t("msg.noAcceptItems", "无可替换项"));
        }
      } else {
        // Revert operation
        let changed = 0;
        let operationType = "";
        
        // Try FS-targeted revert first
        try { 
          changed = await this.applyRevertFile(this.block); 
          operationType = t("msg.scopeFile", "文件");
        } catch (e) {
          console.warn("[dev.srp] FS revert failed, falling back to document", e);
        }
        
        // If FS operation didn't change anything, fallback to current doc
        if (changed === 0) {
          try {
            changed = await this.applyRevert(this.block);
            operationType = t("msg.scopeDocument", "文档");
          } catch (e) {
            console.error("[dev.srp] Document revert failed", e);
          }
        }
        
        if (changed > 0) {
          st.applied = false;
          this.setState(blockKey(this.block), st);
          window.showToast?.(t("msg.changed", "{action} {count} 处（{scope}）", { action: t("msg.reverted", "已回退"), count: changed, scope: operationType }));
          // Update button text immediately
          arBtn.textContent = t("ui.accept", "Accept");
          arBtn.setAttribute("aria-label", t("ui.acceptAria", "Accept replacements"));
        } else {
          window.showToast?.(t("msg.noRevertItems", "无可回退项"));
        }
      }
      document.dispatchEvent(new CustomEvent("dev.srp/refresh"));
    });

    // Helper: compute file counts and update buttons + cache into state
    const updateCountsFromFile = async () => {
      try {
        const counts = await this.computeCountsInFile?.(this.block);
        if (counts && typeof counts.searchMatches === "number" && typeof counts.replaceMatches === "number") {
          copyS.textContent = t("ui.copySearch", "Copy Search ({count})", { count: counts.searchMatches });
          copyR.textContent = t("ui.copyReplace", "Copy Replace ({count})", { count: counts.replaceMatches });
        }
      } catch {}
    };

    // Kick off async refresh of file counts once toolbar renders
    updateCountsFromFile();

    wrap.append(diffBtn, copyS, copyR, arBtn);
    return wrap;
  }
  ignoreEvent() { return false; }
}

export function conflictBlocks() {
  // SRP 折叠范围：在 <<<<<<< SEARCH 行，折叠从标记行结束处开始到 search 部分末尾（不含 ======= 行）；
  // 在 ======= 行，折叠从标记行结束处开始到 replace 部分末尾（不含 >>>>>>> REPLACE 行）
  const srpFoldExt = foldService.of((state, start) => {
    try {
      const doc = state.doc;
      const line = doc.lineAt(start);
      const text = doc.sliceString(line.from, line.to);
      const blocks = scanBlocks(doc);

      if (text.trim() === MARKER_START) {
        const b = blocks.find(bb => bb.startFrom === line.from);
        if (b && b.searchFrom < b.searchTo) {
          // 从标记行结束处开始折叠，保留标记行可见
          return { from: line.to, to: b.searchTo };
        }
      }
      if (text.trim() === MARKER_EQ) {
        const b = blocks.find(bb => bb.eqFrom === line.from);
        if (b && b.replaceFrom < b.replaceTo) {
          // 同理：从 ======= 标记行结束处开始折叠
          return { from: line.to, to: b.replaceTo };
        }
      }
      return null;
    } catch {
      return null;
    }
  });

  // 自定义 gutter：在 <<<<<<< SEARCH 与 ======= 行显示一个按钮，点击切换折叠/展开对应区域
  class SRPMarker extends GutterMarker {
    constructor(kind) {
      super();
      this.kind = kind; // 'search' | 'replace'
    }
    toDOM(view) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "srp-fold-btn " + (this.kind === "search" ? "srp-search" : "srp-replace");
      btn.title = this.kind === "search" ? t("ui.foldSearch", "折叠/展开 Search 部分") : t("ui.foldReplace", "折叠/展开 Replace 部分");
      // 简单内联样式（与主题相容）
      btn.style.width = "14px";
      btn.style.height = "14px";
      btn.style.borderRadius = "50%";
      btn.style.background = "var(--accent)";
      btn.style.border = "1px solid var(--border)";
      btn.style.boxShadow = "0 1px 2px rgba(0,0,0,0.18)";
      btn.style.padding = "0";
      btn.style.margin = "0";
      btn.style.cursor = "pointer";

      // 视觉符号（小三角）
      const icon = document.createElement("span");
      icon.textContent = "▸";
      icon.style.display = "block";
      icon.style.lineHeight = "14px";
      icon.style.fontSize = "12px";
      icon.style.color = "var(--fg)";
      icon.style.textAlign = "center";
      btn.appendChild(icon);

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const line = view.state.doc.lineAt(pos);
        const txt = view.state.doc.sliceString(line.from, line.to);
        // 将折叠起点定位到标记行末尾，保证标记行可见
        const foldStart = line.to;
        try {
          // 光标移动到折叠起点，然后优先尝试展开；若无可展开则执行折叠，实现切换
          view.dispatch({ selection: { anchor: foldStart }, scrollIntoView: true });
          if (!unfoldCode(view)) {
            foldCode(view);
          }
        } catch {}
      });
      return btn;
    }
  }

  // 原有视图插件保持不变
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.stateMap = new Map(); // key -> { diff:boolean, applied:boolean }
      this.decorations = this.build();
      this.bindGlobal();
    }
    bindGlobal() {
      this._onRefresh = () => {
        try { this.view.dispatch({ annotations: [] }); } catch {}
      };
      this._onAcceptAll = () => {
        const doc = this.view.state.doc.toString();
        const blocks = scanBlocks(this.view.state.doc);
        const excluded = blocks.map(b => ({ from: b.startFrom, to: lineAt(this.view.state.doc, b.endFrom).to }));
        let changed = 0;
        let cur = doc;
        for (const b of blocks) {
          const res = replaceOutside(cur, b.searchText, b.replaceText, excluded);
          if (res.count > 0) {
            changed += res.count;
            cur = res.out;
          }
          // mark applied
          const k = blockKey(b);
          const st = this.stateMap.get(k) || { diff: false, applied: false };
          st.applied = true;
          this.stateMap.set(k, st);
        }
        if (changed > 0) {
          this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: cur } });
          window.showToast?.(t("msg.changed", "{action} {count} 处（{scope}）", { action: t("msg.accepted", "已替换"), count: changed, scope: "mock" }));
        } else {
          window.showToast?.(t("msg.noAcceptItems", "无可替换项"));
        }
      };
      this._onRevertAll = () => {
        const doc = this.view.state.doc.toString();
        const blocks = scanBlocks(this.view.state.doc);
        const excluded = blocks.map(b => ({ from: b.startFrom, to: lineAt(this.view.state.doc, b.endFrom).to }));
        let changed = 0;
        let cur = doc;
        for (const b of blocks) {
          const res = replaceOutside(cur, b.replaceText, b.searchText, excluded);
          if (res.count > 0) {
            changed += res.count;
            cur = res.out;
          }
          const k = blockKey(b);
          const st = this.stateMap.get(k) || { diff: false, applied: false };
          st.applied = false;
          this.stateMap.set(k, st);
        }
        if (changed > 0) {
          this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: cur } });
          window.showToast?.(t("msg.changed", "{action} {count} 处（{scope}）", { action: t("msg.reverted", "已回退"), count: changed, scope: "mock" }));
        } else {
          window.showToast?.(t("msg.noRevertItems", "无可回退项"));
        }
      };
      this._onToggleDiffAll = () => {
        const blocks = scanBlocks(this.view.state.doc);
        let next = true;
        // If any is diff on, we turn all off; else turn on
        for (const b of blocks) {
          const st = this.stateMap.get(blockKey(b));
          if (st?.diff) { next = false; break; }
        }
        for (const b of blocks) {
          const k = blockKey(b);
          const st = this.stateMap.get(k) || { diff: false, applied: false };
          st.diff = next;
          this.stateMap.set(k, st);
        }
        document.dispatchEvent(new CustomEvent("dev.srp/refresh"));
      };
      document.addEventListener("dev.srp/refresh", this._onRefresh);
      document.addEventListener("dev.srp/acceptAll", this._onAcceptAll);
      document.addEventListener("dev.srp/revertAll", this._onRevertAll);
      document.addEventListener("dev.srp/toggleDiffAll", this._onToggleDiffAll);
    }
    destroy() {
      try {
        document.removeEventListener("dev.srp/refresh", this._onRefresh);
        document.removeEventListener("dev.srp/acceptAll", this._onAcceptAll);
        document.removeEventListener("dev.srp/revertAll", this._onRevertAll);
        document.removeEventListener("dev.srp/toggleDiffAll", this._onToggleDiffAll);
      } catch {}
    }
    getCountsFor(block) {
      // Prefer cached file counts if available
      const st = this.stateMap.get(blockKey(block));
      if (st?.fsCounts && typeof st.fsCounts.searchMatches === "number" && typeof st.fsCounts.replaceMatches === "number") {
        return st.fsCounts;
      }
      // Fallback to document counts (outside conflict blocks)
      const docText = this.view.state.doc.toString();
      const blocks = scanBlocks(this.view.state.doc);
      const excluded = blocks.map(b => ({ from: b.startFrom, to: lineAt(this.view.state.doc, b.endFrom).to }));
      return {
        searchMatches: countOccurrencesOutside(docText, block.searchText, excluded),
        replaceMatches: countOccurrencesOutside(docText, block.replaceText, excluded)
      };
    }
    async applyReplace(block) {
      try {
        const docText = this.view.state.doc.toString();
        const blocks = scanBlocks(this.view.state.doc);
        const excluded = blocks.map(b => ({ from: b.startFrom, to: lineAt(this.view.state.doc, b.endFrom).to }));
        const res = replaceOutside(docText, block.searchText, block.replaceText, excluded);
        if (res.count > 0) {
          this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: res.out } });
        }
        return res.count;
      } catch (e) {
        console.error("[dev.srp] applyReplace error", e);
        window.showToast?.("Diff 操作失败");
        return 0;
      }
    }
    async applyRevert(block) {
      try {
        const docText = this.view.state.doc.toString();
        const blocks = scanBlocks(this.view.state.doc);
        const excluded = blocks.map(b => ({ from: b.startFrom, to: lineAt(this.view.state.doc, b.endFrom).to }));
        const res = replaceOutside(docText, block.replaceText, block.searchText, excluded);
        if (res.count > 0) {
          this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: res.out } });
        }
        return res.count;
      } catch (e) {
        console.error("[dev.srp] applyRevert error", e);
        window.showToast?.("Diff 操作失败");
        return 0;
      }
    }

    // File-targeted operations based on path line above the block
    async applyReplaceInFile(block) {
      try {
        const path = findFilePathAboveBlock(this.view.state.doc, block);
        if (!path) {
          // No path found, skip FS operation
          return 0;
        }
        
        let entries = await window.zion.commands.executeCommand("fs.getEntries");
        if (!entries || entries.length === 0) {
          // Ask user to authorize and retry once
          const okAuth = await requestFSAuthorization(path);
          if (!okAuth) return 0;
          entries = await window.zion.commands.executeCommand("fs.getEntries");
          if (!entries || entries.length === 0) return 0;
        }
        
        let files = await listAllFilesFromEntries(entries);
        let picked = pickBestFile(files, path);
        if (!picked) {
          const okAuth = await requestFSAuthorization(path);
          if (!okAuth) {
            window.showToast?.(t("msg.noMatchingFile", "未找到匹配的文件：{path}", { path }));
            return 0;
          }
          const entries2 = await window.zion.commands.executeCommand("fs.getEntries");
          files = await listAllFilesFromEntries(entries2 || []);
          picked = pickBestFile(files, path);
          if (!picked) {
            window.showToast?.(t("msg.noMatchingFile", "未找到匹配的文件：{path}", { path }));
            return 0;
          }
        }
        
        const ok = await ensureRW(picked.fileHandle);
        if (!ok) {
          window.showToast?.(t("msg.noWritePermission", "目标文件未授予读写权限"));
          return 0;
        }
        
        const fileObj = await picked.fileHandle.getFile();
        const text = await fileObj.text();
        const res = applyOneReplaceText(text, block.searchText, block.replaceText);
        
        if (res.count > 0) {
          const w = await picked.fileHandle.createWritable();
          await w.write(res.out);
          await w.close();
          window.showToast?.(t("msg.fileChanged", "在文件 {path} 中{action} {count} 处", { path: picked.path, action: t("msg.accepted", "已替换"), count: res.count }));
        }
        
        return res.count;
      } catch (e) {
        console.error("[dev.srp] applyReplaceInFile error", e);
        window.showToast?.(t("msg.fileReplaceFailed", "文件替换失败：{message}", { message: e.message || String(e) }));
        return 0;
      }
    }

    async applyRevertInFile(block) {
      try {
        const path = findFilePathAboveBlock(this.view.state.doc, block);
        if (!path) {
          // No path found, skip FS operation
          return 0;
        }

        let entries = await window.zion.commands.executeCommand("fs.getEntries");
        if (!entries || entries.length === 0) {
          // Ask user to authorize and retry once
          const okAuth = await requestFSAuthorization(path);
          if (!okAuth) return 0;
          entries = await window.zion.commands.executeCommand("fs.getEntries");
          if (!entries || entries.length === 0) return 0;
        }

        let files = await listAllFilesFromEntries(entries);
        let picked = pickBestFile(files, path);
        if (!picked) {
          const okAuth = await requestFSAuthorization(path);
          if (!okAuth) {
            window.showToast?.(t("msg.noMatchingFile", "未找到匹配的文件：{path}", { path }));
            return 0;
          }
          const entries2 = await window.zion.commands.executeCommand("fs.getEntries");
          files = await listAllFilesFromEntries(entries2 || []);
          picked = pickBestFile(files, path);
          if (!picked) {
            window.showToast?.(t("msg.noMatchingFile", "未找到匹配的文件：{path}", { path }));
            return 0;
          }
        }
        
        const ok = await ensureRW(picked.fileHandle);
        if (!ok) {
          window.showToast?.(t("msg.noWritePermission", "目标文件未授予读写权限"));
          return 0;
        }

        const fileObj = await picked.fileHandle.getFile();
        const text = await fileObj.text();
        const res = applyOneReplaceText(text, block.replaceText, block.searchText);

        if (res.count > 0) {
          const w = await picked.fileHandle.createWritable();
          await w.write(res.out);
          await w.close();
          window.showToast?.(t("msg.fileChanged", "在文件 {path} 中{action} {count} 处", { path: picked.path, action: t("msg.reverted", "已回退"), count: res.count }));
        }

        return res.count;
      } catch (e) {
        console.error("[dev.srp] applyRevertInFile error", e);
        window.showToast?.(t("msg.fileRevertFailed", "文件回退失败：{message}", { message: e.message || String(e) }));
        return 0;
      }
    }
    // Compute file counts for a block and cache into state
    async computeCountsInFile(block) {
      try {
        const path = findFilePathAboveBlock(this.view.state.doc, block);
        if (!path) return null;
        const entries = await window.zion.commands.executeCommand("fs.getEntries");
        if (!entries || entries.length === 0) return null;
        const files = await listAllFilesFromEntries(entries);
        const picked = pickBestFile(files, path);
        if (!picked) return null;

        const ok = await ensureRW(picked.fileHandle);
        if (!ok) return null;

        const fileObj = await picked.fileHandle.getFile();
        const text = await fileObj.text();
        const blocks = scanBlocksInText(text);
        const excluded = blocks.map(b => ({ from: b.startFrom, to: b.endFrom }));
        const searchMatches = countOccurrencesOutside(text, block.searchText, excluded);
        const replaceMatches = countOccurrencesOutside(text, block.replaceText, excluded);

        // cache into stateMap
        const k = blockKey(block);
        const st = this.stateMap.get(k) || { diff: false, applied: false };
        st.fsCounts = { searchMatches, replaceMatches };
        this.stateMap.set(k, st);

        // Notify to refresh any labels
        document.dispatchEvent(new CustomEvent("dev.srp/refresh"));
        return st.fsCounts;
      } catch {
        return null;
      }
    }
    getState(k) { return this.stateMap.get(k); }
    setState(k, v) { this.stateMap.set(k, v); }

    build() {
      const view = this.view;
      const doc = view.state.doc;
      const blocks = scanBlocks(doc);

      const builder = new RangeSetBuilder();
      const add = (from, to, dec) => builder.add(from, to, dec);

      // Collect all decorations first, then sort by position
      const decorations = [];
      
      for (const b of blocks) {
        const k = blockKey(b);
        const st = this.stateMap.get(k) || { diff: false, applied: false };

        // Add toolbar at the start of the marker line
        const startLineObj = lineAt(doc, b.startFrom);
        decorations.push({
          from: startLineObj.from, 
          to: startLineObj.from,
          dec: Decoration.widget({
            widget: new ToolbarWidget(
              b,
              (key) => this.getState(key),
              (key, val) => this.setState(key, val),
              (blk) => this.applyReplace(blk),
              (blk) => this.applyRevert(blk),
              (blk) => this.getCountsFor(blk),
              (blk) => this.applyReplaceInFile(blk),
              (blk) => this.applyRevertInFile(blk),
              (blk) => this.computeCountsInFile(blk)
            ),
            side: 1
          }),
          kind: "widget",
          metaSide: 1
        });

        // 冲突块 marker 行高亮
        // <<<<<<< SEARCH 行加红色
        decorations.push({
          from: doc.line(b.startLine).from,
          to: doc.line(b.startLine).from,
          dec: Decoration.line({ class: "srp-line srp-search" }),
          kind: "line",
          metaSide: 0
        });
        // ======= 行加绿色
        decorations.push({
          from: doc.line(b.eqLine).from,
          to: doc.line(b.eqLine).from, 
          dec: Decoration.line({ class: "srp-line srp-replace" }),
          kind: "line",
          metaSide: 0
        });
        // >>>>>>> REPLACE 行加绿色
        decorations.push({
          from: doc.line(b.endLine).from,
          to: doc.line(b.endLine).from,
          dec: Decoration.line({ class: "srp-line srp-replace" }),
          kind: "line",
          metaSide: 0
        });

        // Search region lines: GitHub-like deletion color
        let ln = b.startLine + 1;
        while (ln <= b.eqLine - 1) {
          const l = doc.line(ln);
          decorations.push({
            from: l.from,
            to: l.from,
            dec: Decoration.line({ class: st.diff ? "srp-line srp-search-diff" : "srp-line srp-search" }),
            kind: "line",
            metaSide: 0
          });
          ln++;
        }
        // Replace region lines: GitHub-like addition color
        ln = b.eqLine + 1;
        while (ln <= b.endLine - 1) {
          const l = doc.line(ln);
          decorations.push({
            from: l.from,
            to: l.from,
            dec: Decoration.line({ class: st.diff ? "srp-line srp-replace-diff" : "srp-line srp-replace" }),
            kind: "line",
            metaSide: 0
          });
          ln++;
        }

        // Inline diff highlights for differing segments (GitHub-like)
        if (st.diff) {
          const { aDiff, bDiff } = computeInlineDiffRanges(b.searchText, b.replaceText);
          // deletions in Search region
          for (const seg of aDiff) {
            if (seg.to > seg.from) {
              decorations.push({
                from: b.searchFrom + seg.from,
                to: b.searchFrom + seg.to,
                dec: Decoration.mark({ class: "srp-inline-del" }),
                kind: "mark",
                metaSide: 0
              });
            }
          }
          // additions in Replace region
          for (const seg of bDiff) {
            if (seg.to > seg.from) {
              decorations.push({
                from: b.replaceFrom + seg.from,
                to: b.replaceFrom + seg.to,
                dec: Decoration.mark({ class: "srp-inline-add" }),
                kind: "mark",
                metaSide: 0
              });
            }
          }
        }
      }
      
      // Sort decorations by from position, then by kind/side to satisfy startSide ordering
      decorations.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        // order: line (0) -> mark (1) -> widget (2)
        const kindRank = (k) => k === "line" ? 0 : (k === "mark" ? 1 : 2);
        const ak = kindRank(a.kind);
        const bk = kindRank(b.kind);
        if (ak !== bk) return ak - bk;
        const as = (a.metaSide ?? 0);
        const bs = (b.metaSide ?? 0);
        return as - bs;
      });
      
      // Add sorted decorations to builder
      for (const {from, to, dec} of decorations) {
        builder.add(from, to, dec);
      }

      return builder.finish();
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || (update.transactions && update.transactions.length)) {
        this.decorations = this.build();
      }
    }
  }, {
    decorations: v => v.decorations
  });

  return [plugin, srpFoldExt];
}
