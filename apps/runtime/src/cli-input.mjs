import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { completeFilePath, editDraft } from "./cli-files.mjs";
import { droppedImagePaths, imageLabel } from "./cli-images.mjs";
import { cellWidth, graphemeWidth, graphemes, safeText, terminalTheme, truncate } from "./cli-terminal.mjs";

export const CHAT_COMMANDS = [
  ["/help", "Commands and keyboard shortcuts"],
  ["/sessions", "Search and open a recent conversation"],
  ["/new", "Start a new conversation"],
  ["/open", "Open a conversation by ID"],
  ["/session", "Current conversation and reconnect command"],
  ["/history", "Read this conversation's transcript"],
  ["/search", "Search messages: /search <text>"],
  ["/export", "Export transcript: /export <file.md|file.json>"],
  ["/fork", "Branch through a message: /fork <number>"],
  ["/context", "Context estimate and compression status"],
  ["/compact", "Compress context explicitly; retain original transcript"],
  ["/model", "Choose current model; /model default <id> saves a default"],
  ["/settings", "View configuration sources and choose local preferences"],
  ["/tools", "Inspect recent tool calls and results"],
  ["/details", "Toggle compact or expanded tool activity (Ctrl+O)"],
  ["/recover", "Check uncertain sends; retry|discard; draft restores a failed Run"],
  ["/file", "Attach a UTF-8 file to the next message"],
  ["/files", "List attachments; /files clear removes them"],
  ["/image", "Add image paths; /image without a path opens selection"],
  ["/paste", "Paste an image from the system clipboard"],
  ["/images", "List images; /images open|remove <number> or clear"],
  ["/editor", "Edit the draft with VISUAL or EDITOR"],
  ["/draft", "Show recovered draft; /draft send|clear"],
  ["/attach", "Follow the current or a specific Run"],
  ["/resume", "Resume an interrupted Run"],
  ["/status", "Connection and model"],
  ["/exit", "Leave chat"]
];
const MAX_INPUT = 64 * 1024;
const KEYS = new Map([
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
  ["\x1b[H", "home"], ["\x1b[F", "end"], ["\x1b[1~", "home"], ["\x1b[4~", "end"],
  ["\x1b[3~", "delete"], ["\x1b\r", "newline"], ["\x1b\n", "newline"],
  ["\x1b[13;2u", "newline"], ["\x1b[27;2;13~", "newline"],
  ["\x1b[1;5D", "wordleft"], ["\x1b[1;5C", "wordright"],
  ["\x1bb", "wordleft"], ["\x1bf", "wordright"], ["\x1bv", "pasteimage"], ["\x1bi", "imagemenu"],
  ["\x1b[118;5u", "pasteimage"], ["\x1b[118;3u", "pasteimage"], ["\x1b[118;9u", "pasteimage"],
  ["\x1b[27;5;118~", "pasteimage"], ["\x1b[27;3;118~", "pasteimage"],
  ["\x1bOH", "home"], ["\x1bOF", "end"]
]);

// Own only the composer rows. No alternate screen, hidden scrollback, or transcript
// redraw. Non-TTY lines are queued immediately, including during network awaits.
export class ChatInput {
  constructor(input, output, { environment = process.env, plain = false, onCancel = () => {} } = {}) {
    this.input = input; this.output = output; this.theme = terminalTheme(output, environment);
    this.rich = !plain && this.theme.interactive && Boolean(input.isTTY && input.setRawMode);
    this.onCancel = onCancel; this.queue = []; this.waiter = null; this.ended = false;
    this.environment = environment; this.onDraft = () => {};
    this.text = ""; this.cursor = 0; this.history = []; this.historyIndex = 0;
    this.draft = ""; this.active = false; this.rows = 0; this.screenCursorRow = 0;
    this.decoder = new StringDecoder("utf8"); this.pending = ""; this.pasting = false; this.paste = "";
    this.onEnd = () => {
      if (this.ended) return;
      this.onDraft(this.text);
      this.ended = true; this.deliver(null);
    };
    if (this.rich) {
      this.wasRaw = Boolean(input.isRaw);
      input.setRawMode(true);
      output.write("\x1b[?2004h");
      this.onData = (data) => this.consume(this.decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));
      this.onResize = () => this.render();
      input.on("data", this.onData); input.once("end", this.onEnd);
      output.on("resize", this.onResize); input.resume();
    } else {
      this.rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
      this.rl.on("line", (line) => this.deliver(line));
      this.rl.once("close", this.onEnd);
    }
  }

  deliver(value) {
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(value); }
    else this.queue.push(value);
  }
  async read() {
    if (this.queue.length) return this.queue.shift();
    if (this.ended) return null;
    this.active = true;
    if (this.rich) this.render();
    else if (this.input.isTTY && this.output.isTTY) this.output.write("you> ");
    const value = await new Promise((resolve) => { this.waiter = resolve; });
    this.active = false; this.erase();
    return value;
  }
  async choose(items) {
    if (!this.rich || this.ended) return null;
    const saved = this.text;
    this.picker = items; this.selected = 0; this.text = ""; this.cursor = 0;
    const result = await this.read();
    this.picker = null; this.text = saved; this.cursor = saved.length;
    return result;
  }
  choices() {
    const query = this.text.toLocaleLowerCase();
    return (this.picker || []).filter((item) => `${item.label} ${item.id}`.toLocaleLowerCase().includes(query));
  }
  scheduleRender() {
    if (this.ended) return;
    if (!this.picker && !this.searching) this.onDraft(this.text);
    if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 8);
  }
  setDraft(text) {
    this.text = safeText(text).slice(0, MAX_INPUT); this.cursor = this.text.length;
    this.scheduleRender();
  }
  acquireImages(paths) {
    if (this.attachmentTask || !this.onImages || !this.active || this.picker) return;
    this.notice = "Reading image…";
    this.attachmentTask = Promise.resolve().then(() => this.onImages(paths))
      .then(() => { this.notice = "Image attached · /images manages attachments"; })
      .catch((error) => {
        if (!this.ended) { this.erase(); this.output.write(`${safeText(error.message)}\n\n`); }
        this.notice = "Image import failed · /paste retries · /image <path>";
      })
      .finally(() => { this.attachmentTask = null; this.scheduleRender(); });
    this.scheduleRender();
  }
  commandMatches() {
    if (!this.text.startsWith("/") || /\s/.test(this.text)) return [];
    const query = this.text.slice(1).toLowerCase();
    const exact = CHAT_COMMANDS.filter(([name]) => name === this.text);
    if (exact.length) return exact;
    return CHAT_COMMANDS.filter(([name, description]) => `${name} ${description}`.toLowerCase().includes(query));
  }
  historyMatch() {
    const matches = this.history.filter((item) => item.toLowerCase().includes(this.text.toLowerCase())).reverse();
    return matches[(this.searchIndex || 0) % (matches.length || 1)] || "";
  }
  async edit() {
    if (!this.rich || this.editing) { this.notice = "Use an interactive terminal to open the editor."; return; }
    this.editing = true; this.editorController = new AbortController(); this.erase();
    this.input.off("data", this.onData); this.input.setRawMode(this.wasRaw); this.input.pause();
    this.output.write("\x1b[?2004l");
    try {
      const draft = await editDraft(this.text, this.environment, this.editorController.signal);
      if (!this.ended) this.setDraft(draft);
    }
    catch (error) { if (!this.ended) this.notice = error.message; }
    finally {
      this.editing = false; this.editorController = null;
      if (!this.ended) {
        this.input.setRawMode(true); this.input.on("data", this.onData);
        this.input.resume(); this.output.write("\x1b[?2004h"); this.scheduleRender();
      }
    }
  }
  erase() {
    if (!this.rows) return;
    const columns = Math.max(1, this.output.columns || 80);
    const above = (this.renderedWidths || []).slice(0, this.screenCursorRow)
      .reduce((sum, width) => sum + Math.max(1, Math.ceil(width / columns)), 0)
      + Math.floor((this.renderedCursorCol || 0) / columns);
    this.output.write(`\r${above ? `\x1b[${above}A` : ""}\x1b[J`);
    this.rows = 0; this.screenCursorRow = 0;
  }
  render() {
    if (!this.active || !this.rich || this.editing) return;
    this.erase();
    const width = Math.max(8, (this.output.columns || 80) - 4);
    const lines = [""];
    let col = 0, cursorRow = 0, cursorCol = 0, offset = 0;
    for (const ch of graphemes(this.text)) {
      if (offset === this.cursor) { cursorRow = lines.length - 1; cursorCol = col; }
      if (ch === "\n") { lines.push(""); col = 0; }
      else {
        const size = graphemeWidth(ch);
        if (col + size > width) { lines.push(""); col = 0; }
        if (offset === this.cursor) { cursorRow = lines.length - 1; cursorCol = col; }
        lines[lines.length - 1] += ch; col += size;
      }
      offset += ch.length;
    }
    if (this.cursor === this.text.length) { cursorRow = lines.length - 1; cursorCol = col; }
    const maxRows = Math.max(1, Math.min(7, (this.output.rows || 24) - 5));
    const start = Math.max(0, cursorRow - maxRows + 1);
    const visible = lines.slice(start, start + maxRows);
    const rendered = visible.map((line, index) => `${this.theme.accent(index + start ? "· " : "› ")}${line}`);
    if (this.searching) {
      this.searchResult = this.historyMatch();
      rendered.push(this.theme.dim(truncate(`history › ${this.searchResult || "No match"}`, width + 2)));
      rendered.push(this.theme.dim("Ctrl+R next · Enter edit · Esc back"));
    } else if (this.picker) {
      const choices = this.choices();
      this.selected = Math.min(this.selected || 0, Math.max(0, choices.length - 1));
      const first = Math.max(0, this.selected - 3);
      const count = Math.max(1, Math.min(5, (this.output.rows || 24) - visible.length - 3));
      rendered.push(...choices.slice(first, first + count).map((item, index) =>
        truncate(`${first + index === this.selected ? "›" : " "} ${item.label} · ${item.id}`, width + 2)));
      rendered.push(this.theme.dim(truncate(choices.length ? "↑↓ select · Enter open · Esc back" : "No matches · Esc back", width + 2)));
    } else {
      const images = this.images || [];
      const count = Math.max(1, Math.min(3, (this.output.rows || 24) - visible.length - 3));
      for (const [index, image] of images.slice(0, count).entries())
        rendered.push(this.theme.dim(truncate(imageLabel(image, index, width + 2), width + 2)));
      if (images.length > count) rendered.push(this.theme.dim(`+${images.length - count} images · /images`));
      const matches = this.commandMatches();
      if (this.commandMenu && matches.length) {
        this.commandIndex = Math.min(this.commandIndex || 0, matches.length - 1);
        const first = Math.max(0, this.commandIndex - 2);
        rendered.push(...matches.slice(first, first + 3).map(([name, description], index) =>
          this.theme.dim(truncate(`${first + index === this.commandIndex ? "›" : " "} ${name}  ${description}`, width + 2))));
      }
      const hint = this.notice || (matches.length
        ? `${matches.slice(0, 4).map(([name]) => name).join("  ")} · Tab complete`
        : this.statusHint || "Enter send · Alt+Enter newline · Ctrl+V image · /paste · / commands");
      rendered.push(this.theme.dim(truncate(hint, width + 2)));
    }
    this.output.write(rendered.join("\n"));
    const targetRow = cursorRow - start;
    const up = rendered.length - 1 - targetRow;
    this.output.write(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[${cursorCol + 3}G`);
    this.rows = rendered.length; this.screenCursorRow = targetRow;
    this.renderedWidths = rendered.map(cellWidth); this.renderedCursorCol = cursorCol + 2;
  }
  insert(value) {
    const clean = safeText(String(value).replace(/\r\n?/g, "\n")).replace(/\t/g, "  ");
    if (this.text.length + clean.length > MAX_INPUT) {
      this.notice = "Input limit: 64 KiB. Shorten the draft before sending.";
      return;
    }
    this.text = this.text.slice(0, this.cursor) + clean + this.text.slice(this.cursor);
    this.cursor += clean.length; this.notice = ""; this.selected = 0;
    this.commandMenu = false; this.searchIndex = 0;
  }
  consume(value) {
    if (this.active && !this.picker && !this.pasting && !this.pending && !this.attachmentTask && !this.text.startsWith("/") && this.onImages) {
      const paths = droppedImagePaths(value);
      if (paths) { this.acquireImages(paths); return; }
    }
    this.pending += value;
    clearTimeout(this.escapeTimer);
    while (this.pending) {
      if (this.pasting) {
        const end = this.pending.indexOf("\x1b[201~");
        if (end < 0) {
          // Retain the potential split delimiter, without unbounded paste storage.
          const take = Math.max(0, this.pending.length - 5);
          this.paste += this.pending.slice(0, take);
          if (this.paste.length > MAX_INPUT) { this.paste = this.paste.slice(0, MAX_INPUT); this.pasteOverflow = true; }
          this.pending = this.pending.slice(take);
          break;
        }
        this.paste += this.pending.slice(0, end);
        if (this.pasteOverflow || this.paste.length > MAX_INPUT) this.notice = "Paste exceeds 64 KiB; draft unchanged.";
        else {
          const paths = this.active && !this.picker && !this.attachmentTask && droppedImagePaths(this.paste);
          if (!this.paste && this.onImages) this.acquireImages(null);
          else if (paths && this.onImages) this.acquireImages(paths);
          else this.insert(this.paste);
        }
        this.pasteOverflow = false; this.paste = ""; this.pasting = false;
        this.pending = this.pending.slice(end + 6);
        continue;
      }
      if (this.pending.startsWith("\x1b[200~")) {
        this.pasting = true; this.pending = this.pending.slice(6); continue;
      }
      if (this.pending[0] === "\x1b") {
        const known = [...KEYS.keys()].find((key) => this.pending.startsWith(key));
        if (known) { this.key(KEYS.get(known)); this.pending = this.pending.slice(known.length); continue; }
        const incomplete = ["\x1b[200~", ...KEYS.keys()].some((key) => key.startsWith(this.pending))
          || /^\x1b\[[0-?]*[ -/]*$/.test(this.pending);
        const sequence = !incomplete && this.pending.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[^\[])/s)?.[0];
        if (sequence) { this.pending = this.pending.slice(sequence.length); continue; }
        this.escapeTimer = setTimeout(() => {
          const standalone = this.pending === "\x1b";
          this.pending = ""; if (standalone) this.key("escape"); this.scheduleRender();
        }, 80);
        break;
      }
      const text = this.pending.match(/^[^\x00-\x1f\x7f\x1b]+/)?.[0];
      if (text) { this.insert(text); this.pending = this.pending.slice(text.length); continue; }
      const code = this.pending.charCodeAt(0);
      this.pending = this.pending.slice(1);
      this.key(({ 3: "cancel", 4: "eof", 13: "enter", 10: "newline", 9: "tab",
        127: "backspace", 8: "backspace", 1: "home", 5: "end", 2: "left",
        6: "right", 16: "up", 14: "down", 21: "killstart", 11: "killend",
        23: "wordbackspace", 12: "redraw", 18: "search", 7: "editor", 22: "pasteimage", 15: "details" })[code]);
    }
    this.scheduleRender();
  }
  key(key) {
    if (!key) return;
    if (key === "details" && !this.picker && !this.searching && !this.editing) {
      this.onDetails?.(); return;
    }
    if (key === "pasteimage") { this.acquireImages(null); return; }
    if (key === "imagemenu" && this.active && !this.picker && !this.attachmentTask && this.images?.length) {
      this.imageDraft = this.text;
      this.picker = this.images.flatMap((image, index) => [
        { id: `open ${index + 1}`, label: `View ${imageLabel(image, index)}` },
        { id: `remove ${index + 1}`, label: `Remove [Image ${index + 1}] ${image.name}` }
      ]);
      this.text = ""; this.cursor = 0; this.selected = 0; return;
    }
    if (this.attachmentTask && ["enter", "cancel", "escape", "eof"].includes(key)) {
      this.notice = "Finishing image import…"; return;
    }
    if (key === "editor" && this.active && !this.picker) { void this.edit(); return; }
    if (key === "search" && this.active && !this.picker) {
      if (!this.searching) { this.searchDraft = this.text; this.searching = true; this.text = ""; this.cursor = 0; this.searchIndex = 0; }
      else this.searchIndex++;
      this.render(); return;
    }
    if (this.searching && ["enter", "escape", "cancel"].includes(key)) {
      this.text = key === "enter" ? this.historyMatch() || this.searchDraft : this.searchDraft;
      this.searching = false; this.cursor = this.text.length; return;
    }
    if (key === "cancel" || key === "escape") {
      if (!this.active) { this.onCancel(); return; }
      if (this.commandMenu && key === "escape") { this.commandMenu = false; return; }
      if (this.picker) {
        if (this.imageDraft !== undefined) {
          this.picker = null; this.text = this.imageDraft; this.cursor = this.text.length; this.imageDraft = undefined;
        } else if (this.pathDraft !== undefined) {
          this.picker = null; this.text = this.pathDraft; this.cursor = this.text.length; this.pathDraft = undefined;
        } else { this.deliver(null); this.active = false; this.erase(); }
        return;
      }
      if (this.text) { this.text = ""; this.cursor = 0; this.notice = ""; }
      else if (key === "cancel") { this.deliver(null); this.active = false; this.erase(); }
      return;
    }
    if (key === "enter") {
      if (!this.active) { this.notice = "Draft kept · Enter to send when ready"; return; }
      if (this.picker) {
        const item = this.choices()[this.selected || 0];
        if (item) {
          if (this.imageDraft !== undefined) {
            this.picker = null; this.text = this.imageDraft; this.cursor = this.text.length; this.imageDraft = undefined;
            this.attachmentTask = Promise.resolve().then(() => this.onImageAction?.(item.id))
              .then(() => { this.notice = item.id.startsWith("open") ? "Opened image" : "Image removed"; })
              .catch((error) => { this.notice = error.message; })
              .finally(() => { this.attachmentTask = null; this.scheduleRender(); });
          } else if (this.pathDraft !== undefined) { this.picker = null; this.pathDraft = undefined; this.setDraft(item.id); }
          else { this.deliver(item.id); this.active = false; this.erase(); }
        }
        return;
      }
      if (this.text.endsWith("\\") && this.cursor === this.text.length) {
        this.text = this.text.slice(0, -1); this.cursor--; this.insert("\n"); return;
      }
      const text = this.text.trim();
      if (!text && !this.images?.length) return;
      const paths = droppedImagePaths(text);
      if (paths && this.onImages) { this.text = ""; this.cursor = 0; this.acquireImages(paths); return; }
      this.erase(); this.output.write(`${this.theme.accent("›")} ${safeText(text)}${this.images?.length ? ` · ${this.images.length} image(s)` : ""}\n\n`);
      if (this.history.at(-1) !== text) this.history.push(text);
      if (this.history.length > 100) this.history.shift();
      this.historyIndex = this.history.length; this.text = ""; this.cursor = 0; this.draft = "";
      this.active = false; this.deliver(text); return;
    }
    if (key === "eof" && !this.text && this.active) { this.deliver(null); this.active = false; this.erase(); return; }
    if (key === "newline") { this.insert("\n"); return; }
    if (key === "tab") {
      if (/^\/(?:file|export|image)\s/.test(this.text)) {
        const original = this.text;
        void completeFilePath(original).then((items) => {
          if (this.text !== original || !this.active || this.picker) return;
          if (items?.length === 1) this.setDraft(items[0].id);
          else if (items?.length) {
            this.pathDraft = original; this.picker = items; this.text = ""; this.cursor = 0; this.selected = 0;
          } else this.notice = "No matching paths.";
          this.scheduleRender();
        }).catch((error) => { this.notice = error.message; this.scheduleRender(); });
        return;
      }
      const names = this.commandMatches().map(([name]) => name);
      if (names.length === 1) { this.text = names[0]; this.cursor = this.text.length; }
      else if (names.length > 1) {
        if (this.commandMenu) { this.text = names[this.commandIndex || 0]; this.cursor = this.text.length; this.commandMenu = false; }
        else { this.commandMenu = true; this.commandIndex = 0; }
      }
      return;
    }
    if (this.commandMenu && (key === "up" || key === "down")) {
      const count = this.commandMatches().length;
      this.commandIndex = ((this.commandIndex || 0) + (key === "up" ? -1 : 1) + count) % count;
      return;
    }
    if (this.picker && (key === "up" || key === "down")) {
      const length = this.choices().length;
      this.selected = length ? ((this.selected || 0) + (key === "up" ? -1 : 1) + length) % length : 0;
      return;
    }
    if ((key === "up" || key === "down") && !this.text.includes("\n")) {
      if (this.historyIndex === this.history.length) this.draft = this.text;
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key === "up" ? -1 : 1)));
      this.text = this.history[this.historyIndex] ?? this.draft; this.cursor = this.text.length; return;
    }
    const before = this.text.slice(0, this.cursor), after = this.text.slice(this.cursor);
    const previous = graphemes(before).at(-1)?.length || 0;
    const next = graphemes(after)[0]?.length || 0;
    if (key === "left") this.cursor -= previous;
    if (key === "right") this.cursor += next;
    if (key === "home") this.cursor = before.lastIndexOf("\n") + 1;
    if (key === "end") this.cursor += after.includes("\n") ? after.indexOf("\n") : after.length;
    if (key === "wordleft") this.cursor -= before.match(/\S+\s*$|\s+$/u)?.[0].length || 0;
    if (key === "wordright") this.cursor += after.match(/^\s*\S+|^\s+/u)?.[0].length || 0;
    if (key === "backspace") { this.text = before.slice(0, -previous || before.length) + after; this.cursor -= previous; }
    if (key === "delete" || key === "eof") this.text = before + after.slice(next);
    if (key === "killstart") { const start = before.lastIndexOf("\n") + 1; this.text = before.slice(0, start) + after; this.cursor = start; }
    if (key === "killend") this.text = before + (after.includes("\n") ? after.slice(after.indexOf("\n")) : "");
    if (key === "wordbackspace") {
      const count = before.match(/\S+\s*$|\s+$/u)?.[0].length || 0;
      this.text = before.slice(0, before.length - count) + after; this.cursor -= count;
    }
    if (key === "up" || key === "down") {
      const start = before.lastIndexOf("\n") + 1, column = graphemes(before.slice(start)).length;
      if (key === "up" && start > 0) {
        const previousStart = this.text.lastIndexOf("\n", start - 2) + 1;
        this.cursor = previousStart + graphemes(this.text.slice(previousStart, start - 1)).slice(0, column).join("").length;
      } else if (key === "down" && after.includes("\n")) {
        const nextStart = this.cursor + after.indexOf("\n") + 1;
        const nextEnd = this.text.indexOf("\n", nextStart);
        this.cursor = nextStart + graphemes(this.text.slice(nextStart, nextEnd < 0 ? this.text.length : nextEnd)).slice(0, column).join("").length;
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    this.editorController?.abort();
    clearTimeout(this.renderTimer); clearTimeout(this.escapeTimer); this.erase();
    this.rl?.close();
    if (this.rich) {
      this.input.off("data", this.onData); this.input.off("end", this.onEnd);
      this.output.off("resize", this.onResize);
      this.input.setRawMode(this.wasRaw); this.input.pause();
      this.output.write("\x1b[?2004l");
    }
    this.ended = true;
  }
}
