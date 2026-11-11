import { safeText, truncate } from "./cli-text.mjs";
import { createMarkdownStream } from "./cli-markdown.mjs";
export { safeText, truncate, graphemes, graphemeWidth, cellWidth } from "./cli-text.mjs";

export function terminalTheme(output, environment = process.env) {
  const interactive = Boolean(output.isTTY && environment.TERM !== "dumb");
  const color = interactive && !Object.hasOwn(environment, "NO_COLOR");
  const background = Number(String(environment.COLORFGBG || "").split(";").at(-1));
  const light = environment.ZIOON_THEME === "light" || environment.ZIOON_THEME !== "dark" && background >= 7;
  const style = (code) => (text) => color ? `\x1b[${code}m${safeText(text)}\x1b[0m` : safeText(text);
  return { interactive, color, light, accent: style(light ? "34" : "36"), bold: style("1"), dim: style(light ? "90" : "2"), danger: style("31") };
}

// Interactive terminals render Markdown. Pipe/plain mode keeps the source text.
export function createAnswerRenderer(output, theme = terminalTheme(output)) {
  if (theme.interactive) return createMarkdownStream(output, theme);
  let pending = "", timer = null, lineStart = true;
  function flush() {
    clearTimeout(timer); timer = null;
    if (!pending) return;
    const text = safeText(pending); pending = "";
    output.write(text);
    lineStart = text.endsWith("\n");
  }
  return {
    write(text) {
      pending += String(text || "");
      if (pending.length >= 8192) flush();
      else if (!timer) timer = setTimeout(flush, 24);
    },
    flush,
    end() { flush(); if (!lineStart) output.write("\n"); lineStart = true; }
  };
}

export function createActivity(output, theme = terminalTheme(output), { detailShortcut = false } = {}) {
  let timer, redrawTimer, visible = false, label = "", started = 0, last = "";
  const erase = () => { if (visible) { output.write("\r\x1b[2K"); visible = false; } };
  const draw = () => {
    const width = Math.max(8, (output.columns || 80) - 1);
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const suffix = width >= 60 && detailShortcut ? ` · ${elapsed}s · Esc stop · Ctrl+O details`
      : width >= 35 ? ` · ${elapsed}s · Esc stop` : ` · ${elapsed}s`;
    const title = truncate(label, Math.max(1, width - suffix.length - 2));
    const text = `  ${title}${suffix}`;
    if (text === last && visible) return;
    erase(); output.write(`  ${theme.accent(title)}${theme.dim(suffix)}`);
    visible = true; last = text;
  };
  return {
    start(value = "Thinking") {
      this.stop(); label = value; started = Date.now();
      if (theme.interactive) { draw(); timer = setInterval(draw, 1000); timer.unref?.(); }
    },
    startIfStopped(value) { if (!timer) this.start(value); },
    update(value) {
      label = safeText(value).replace(/\n/g, " ");
      if (timer && !redrawTimer) redrawTimer = setTimeout(() => { redrawTimer = null; if (timer) draw(); }, 80);
    },
    stop() { clearInterval(timer); clearTimeout(redrawTimer); timer = redrawTimer = null; erase(); last = ""; },
    finish() { this.stop(); }
  };
}

export function printList(output, values, kind, environment = process.env) {
  const theme = terminalTheme(output, environment);
  if (!theme.interactive) {
    output.write(`${JSON.stringify(values, null, 2)}\n`);
    return;
  }
  if (!values.length) { output.write(theme.dim(`No ${kind} yet.\n`)); return; }
  const width = Math.max(20, (output.columns || 80) - 4);
  for (const value of values) {
    const title = value.title || value.name || value.id || "Untitled";
    output.write(`  ${theme.bold(truncate(title, width))}\n`);
    const timestamp = value.updatedAt || value.createdAt;
    const date = timestamp ? new Date(timestamp) : null;
    const dateText = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 16).replace("T", " ") : "";
    const detail = [value.id || value.url, value.status, dateText].filter(Boolean).join(" · ");
    if (detail) output.write(`  ${theme.dim(truncate(detail, width))}\n`);
    output.write("\n");
  }
}

export function printAuthStatus(output, value, environment = process.env) {
  const theme = terminalTheme(output, environment);
  if (!theme.interactive) { output.write(`${JSON.stringify(value, null, 2)}\n`); return; }
  if (!value.authenticated) { output.write("Not signed in. Run: zioon auth login\n"); return; }
  output.write(`${theme.bold(value.user?.name || value.profileName || "Signed in")}\n`);
  if (value.user?.email) output.write(`${theme.dim(value.user.email)}\n`);
  if (value.expired) output.write("Session expired. Run: zioon auth login\n");
  else output.write("Signed in · ready to chat\n");
}
