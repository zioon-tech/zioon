import { displayPreferenceStorage, readDisplayPreference, readMinimapPreference, DISPLAY_STATE_KEYS, type DisplayPreferenceKey } from "../editor/display-preferences";
import { mountEditorHeaderMenu, type EditorHeaderMenuItem } from "./editor-header-menu";
import { editorConfigurationMenuItems, editorCoreMenuItems } from "./editor-display-contributions.js";
import { openEditorConfigPanel } from "./editor-config-panel.js";
import { mountEditorAppearanceControls } from "./editor-appearance-controls";

/** Reading adapter for the original Workbench menu and config panel. */
export function mountEditorDisplayMenu(header: HTMLElement, host: any, documentId: string) {
  const set = (key: DisplayPreferenceKey, value: unknown) =>
    displayPreferenceStorage.setItem(key, typeof value === "boolean" ? value ? "1" : "0" : String(value));
  const toggle = (key: DisplayPreferenceKey) => set(key, !readDisplayPreference(key));
  for (const [key, stateKey] of Object.entries(DISPLAY_STATE_KEYS)) {
    const suffix = key.slice("zion.".length);
    if (typeof readDisplayPreference(key as DisplayPreferenceKey) !== "boolean") continue;
    host.commands.registerCommand(`zion.toggle${suffix[0].toUpperCase()}${suffix.slice(1)}`, () => toggle(key as DisplayPreferenceKey));
    host.commands.registerCommand(`dev.editor.toggle${suffix[0].toUpperCase()}${suffix.slice(1)}`, () => toggle(key as DisplayPreferenceKey));
    host.state.set(stateKey, key === "zion.minimap" ? readMinimapPreference(documentId) : readDisplayPreference(key as DisplayPreferenceKey));
  }
  const toggleMinimap = () => {
    const enabled = readMinimapPreference(documentId);
    displayPreferenceStorage.setItem(`zion.minimap.session.${documentId}`, enabled ? "0" : "1");
  };
  host.commands.registerCommand("dev.editor.toggleMinimap", toggleMinimap);
  host.commands.registerCommand("zion.toggleWysiwygKeepActiveLineRendered", () => toggle("zion.wysiwyg.keepActiveLineRendered"));
  for (const [value, suffix] of [["standard", "Standard"], ["wide", "Wide"], ["full", "Full"]])
    host.commands.registerCommand(`dev.editor.setWidth${suffix}`, () => set("zion.editorWidthMode", value));
  for (const [value, suffix] of [["medium", "Medium"], ["small", "Small"], ["xsmall", "XSmall"]])
    host.commands.registerCommand(`dev.editor.setHeadingSize${suffix}`, () => set("zion.headingSize", value));
  let config: { dispose(): void } | undefined;
  const items: EditorHeaderMenuItem[] = [...editorConfigurationMenuItems(host), ...editorCoreMenuItems(host)];
  items.push({ id: "dev.editor.menu.openConfigPanel", title: "Editor Config…", section: "Editor", order: 40,
    onClick: () => {
      config?.dispose();
      config = openEditorConfigPanel(host, { readOnly: true, mountAppearance: mountEditorAppearanceControls });
    } });
  for (const [key, title, section, order] of [
    ["zion.selectionHighlight", "Selection Highlight", "Editor", 20],
    ["dev.sticky-user-header.enabled", "固定用户头部", "Chat", 77],
    ["zion.roleUserBlockBackground", "User Block Background", "Chat", 76],
    ["zion.panelFocusHighlight", "高亮当前分屏", "Layout", 80]
  ] as Array<[DisplayPreferenceKey, string, string, number]>)
    items.push({ id: key, title, section, order, kind: "toggle",
      getChecked: () => !!readDisplayPreference(key), onClick: () => toggle(key) });
  const menu = mountEditorHeaderMenu(header, { list: () => items,
    context: () => ({ panelId: host.window.activeEditor.panelId, sessionId: documentId }) });
  return { toggleVim: () => toggle("zion.vimMode"), dispose() { config?.dispose(); menu.dispose(); } };
}
