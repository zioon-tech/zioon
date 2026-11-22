import type { EditorCore, VimOperationalMode } from "./EditorCore";
import { readDisplayPreference } from "./display-preferences";
const cores = new Map<EditorCore, { readOnly: boolean; dispose(): void }>();
const listeners = new Set<(mode: VimOperationalMode) => void>();
let mode: VimOperationalMode = "normal", applying = false;
export function currentVimOperationalMode() { return mode; }
export function subscribeVimOperationalMode(listener: (value: VimOperationalMode) => void) {
  listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
}
export function applyCoordinatedVimMode(core: EditorCore, readOnly = cores.get(core)?.readOnly) {
  const next = readOnly && (mode === "insert" || mode === "replace") ? "normal" : mode;
  if (!readDisplayPreference("zion.vimMode")) return;
  core.setVimOperationalMode(next, { preserveViewState: !core.view.dom.contains(document.activeElement) });
}
/** Original Workbench mode coordination, owned by the shared editor surface. */
export function bindVimCoordination(core: EditorCore, readOnly: boolean) {
  if (cores.has(core)) return;
  const subscription = core.onVimOperationalModeChange(next => {
    if (applying || !readDisplayPreference("zion.vimMode")) return;
    mode = next; applying = true;
    try { for (const target of cores.keys()) applyCoordinatedVimMode(target); }
    finally { applying = false; }
    for (const listener of listeners) listener(mode);
  });
  const binding = { readOnly, dispose() {
    subscription.dispose(); cores.delete(core); if (!cores.size) mode = "normal";
  } };
  cores.set(core, binding); core.own(binding); applyCoordinatedVimMode(core);
}
