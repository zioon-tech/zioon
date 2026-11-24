import { markWorkbenchStage } from "../runtime/workbench-performance";
import "./presentation.css";

const active = new WeakMap<HTMLElement, object>();

/** Keep geometry measurable while the document and its decorations initialize.
 * Each pane has its own completion; another pane's network request cannot block it. */
export function beginSessionPresentation(editor: any) {
  const view = editor?.getView?.();
  const host = view?.dom?.closest?.(".zion-editor-host") as HTMLElement | null;
  if (!view?.dom || !host) return { finish: async () => {}, fail: () => {}, cancel: () => {} };
  const token = {};
  active.set(host, token);
  for (const previous of host.querySelectorAll(".zion-session-loading")) previous.remove();
  const label = document.createElement("div");
  label.className = "zion-session-loading";
  label.setAttribute("role", "status");
  label.textContent = "正在恢复会话…";
  host.appendChild(label);
  host.classList.add("is-session-loading");
  host.setAttribute("aria-busy", "true");
  const current = () => active.get(host) === token;
  const reveal = () => {
    if (!current()) return;
    host.classList.remove("is-session-loading");
    host.removeAttribute("aria-busy");
    label.remove();
    active.delete(host);
  };
  return {
    async finish() {
      if (!current()) return;
      // CodeMirror performs its measurement before the pane becomes visible.
      await new Promise<void>(resolve => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const fallback = window.setTimeout(done, 150);
        view.requestMeasure({
          read: () => null,
          write: () => { clearTimeout(fallback); done(); }
        });
      });
      if (!current()) return;
      reveal();
      markWorkbenchStage("panel-stable", editor?.panelId);
    },
    fail(retry?: () => void) {
      if (!current()) return;
      host.removeAttribute("aria-busy");
      label.textContent = "会话暂时未能加载";
      if (retry) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "重试";
        button.onclick = retry;
        label.appendChild(button);
      }
    },
    cancel: reveal
  };
}
