import { Compartment, EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { findNext, findPrevious, SearchQuery, selectMatches, setSearchQuery } from "@codemirror/search";
import { EditorCore, type EditorCoreOptions } from "./EditorCore";
import { StateBus } from "../core/state-bus";
import { applyDisplayPresentation, applyEditorWidth, displayPreferenceStorage, DISPLAY_STATE_KEYS,
  readDisplayPreference, readMinimapPreference, subscribeDisplayPreferences } from "./display-preferences";
import { getEffectivePrefixes, readConversationRoleBlocks, roles } from "../../extensions/dev.roles/roles.js";
import { stickyUserHeaderView } from "../../extensions/dev.sticky-user-header/main.js";
import { createChatOverviewRail } from "../../extensions/dev.langchain-chat/overview-rail.js";
import { createConversationOutlineController } from "../../extensions/dev.toc/main.js";
import { createConversationSearchController } from "../../extensions/dev.search-replace/main.js";
import { computeConversationSearchMatches, type ConversationSearchOptions, type ConversationSearchMatch } from "./search-panel";
import "../../extensions/dev.roles/styles.css";
import "../../extensions/dev.toc/styles.css";
import "../../extensions/dev.sticky-user-header/styles.css";
import "../../extensions/dev.search-replace-plus/styles.css";
import type { I18nManager } from "../i18n/i18nManager";
import { applyCoordinatedVimMode, bindVimCoordination } from "./vim-coordination";
import { resolveWorkbenchDisplayDocument } from "../runtime/workbench-space";

type Disposable = { dispose(): void };
export type SurfaceSearchMatch = ConversationSearchMatch & { cardId?: string };
export type SurfaceSearchProvider = {
  text(): string;
  extra?(query: string, options: ConversationSearchOptions): SurfaceSearchMatch[];
  reveal?(match: SurfaceSearchMatch): void;
};
const bindings = new WeakMap<EditorCore, Disposable>();
const boolean = (key: Parameters<typeof readDisplayPreference>[0]) => !!readDisplayPreference(key);
export function applyEditorCorePreferences(core: EditorCore, documentId = core.getSessionId() || "") {
  core.setWysiwygEnabled(boolean("zion.wysiwyg"));
  core.setWysiwygKeepActiveLineRendered(boolean("zion.wysiwyg.keepActiveLineRendered"));
  core.setLineNumbersEnabled(boolean("zion.lineNumbers"));
  core.setActiveLineHighlightEnabled(boolean("zion.activeLineHighlight"));
  core.setSyntaxHighlightEnabled(boolean("zion.syntaxHighlight"));
  core.setAutoIndentEnabled(boolean("zion.autoIndent"));
  core.setFoldingEnabled(boolean("zion.folding"));
  core.setLineWrapEnabled(boolean("zion.lineWrap"));
  core.setSelectionHighlightEnabled(boolean("zion.selectionHighlight"));
  core.setMinimapEnabled(readMinimapPreference(documentId));
  core.setVimModeEnabled(boolean("zion.vimMode"));
  applyCoordinatedVimMode(core);
  core.view.dom.dataset.vimEnabled = String(boolean("zion.vimMode"));
  applyEditorWidth(core.view);
  applyDisplayPresentation(document.documentElement);
}
export function bindEditorCorePreferences(core: EditorCore, documentId?: () => string) {
  if (bindings.has(core)) return;
  let disposed = false, generation = 0;
  const apply = () => {
    const id = documentId?.() || core.getSessionId() || "";
    applyEditorCorePreferences(core, id);
    if (documentId || !id) return;
    const request = ++generation;
    void resolveWorkbenchDisplayDocument(id).then(identity => {
      if (!disposed && request === generation && core.getSessionId() === id)
        applyEditorCorePreferences(core, identity);
    }).catch(() => {});
  };
  apply();
  const subscription = subscribeDisplayPreferences(apply);
  const session = core.onSessionChanged(apply);
  bindings.set(core, subscription);
  core.own({ dispose() { disposed = true; generation++; subscription.dispose(); session.dispose(); bindings.delete(core); } });
}
export function configuredEditorRoles() {
  const parse = (key: Parameters<typeof readDisplayPreference>[0]) => {
    try { const value = JSON.parse(String(readDisplayPreference(key))); return Array.isArray(value) ? value : []; } catch { return []; }
  };
  return {
    prefixes: getEffectivePrefixes({ readOnly: true, prefixes: [...parse("zion.roles.prefixes"), ...parse("dev.roles.prefixes")] }),
    highlightBlockRoles: parse("zion.roles.highlightBlockRoles")
  };
}

/** This instance host contains reading contributions only. It never installs the
 * Workbench Registry, exposes window.zion, or grants document/source mutation. */
function createReadingContributionHost(core: EditorCore, documentId: string, i18n?: I18nManager) {
  const state = new StateBus();
  const commands = new Map<string, (...args: any[]) => any>();
  const eventListeners = new Map<string, Set<(value: any) => void>>();
  const keyBindings: any[] = [];
  const editor = {
    panelId: core.getPanelId(), editorId: core.getEditorId(),
    core: { view: core.view }, getView: () => core.view,
    getValue: () => core.getValue(), getSelection: () => core.view.state.sliceDoc(
      core.view.state.selection.main.from, core.view.state.selection.main.to),
    getCursor: () => {
      const pos = core.view.state.selection.main.head, line = core.view.state.doc.lineAt(pos);
      return { line: line.number - 1, ch: pos - line.from };
    },
    setCursor: ({ line, ch = 0 }: { line: number; ch?: number }) => {
      const target = core.view.state.doc.line(Math.max(1, Math.min(core.view.state.doc.lines, line + 1)));
      core.view.dispatch({ selection: { anchor: Math.min(target.to, target.from + ch) } });
    },
    focus: () => core.view.focus(),
    addVisualExtension: (extension: Extension) => core.addExternalExtension(extension)
  };
  const host = {
    state, window: { activeEditor: editor }, config: { roles: configuredEditorRoles() },
    roles: { getIndex: () => ({ blocks: readConversationRoleBlocks(core.view.state, configuredEditorRoles().prefixes) }) },
    commands: {
      registerCommand(id: string, callback: (...args: any[]) => any) {
        commands.set(id, callback);
        return { dispose: () => { commands.delete(id); } };
      },
      executeCommand: (id: string, ...args: any[]) => commands.get(id)?.(...args)
    },
    events: {
      on(id: string, callback: (value: any) => void) {
        const set = eventListeners.get(id) || new Set(); set.add(callback); eventListeners.set(id, set);
        return { dispose: () => { set.delete(callback); } };
      },
      off: (id: string, callback: (value: any) => void) => eventListeners.get(id)?.delete(callback)
    },
    i18n,
    editor: {
      registerDecorator: (contribution: { apply(editor: any): Disposable }) => contribution.apply(editor)
    },
    keybindings: {
      register(binding: any) {
        keyBindings.push(binding);
        return { dispose: () => { const index = keyBindings.indexOf(binding); if (index >= 0) keyBindings.splice(index, 1); } };
      }
    }
  };
  const applyState = () => {
    host.config.roles = configuredEditorRoles();
    for (const [key, stateKey] of Object.entries(DISPLAY_STATE_KEYS)) state.set(stateKey!, readDisplayPreference(key as any));
    state.set("ui.minimapEnabled", readMinimapPreference(documentId));
  };
  applyState();
  core.own(subscribeDisplayPreferences(applyState));
  return { host, editor, installKeymap() {
    core.addExternalExtension(keymap.of(keyBindings.map(binding => ({
      key: binding.key,
      run: () => {
        if (binding.when === "searchReplaceVisible" && !state.get("searchReplace.visible")) return false;
        host.commands.executeCommand(binding.command); return true;
      }
    }))));
  } };
}

/** Single creation path for Workbench slots and both reader entries. Native
 * plugin adapters use these same controllers with their existing host APIs. */
export function createEditorPanelSurface(parent: HTMLElement, initialValue = "", panelId = "panel-0",
  options: EditorCoreOptions & {
    documentId?: string; translate?: (key: string, fallback: string) => string; i18n?: I18nManager;
    searchProvider?: SurfaceSearchProvider;
  } = {}) {
  const core = new EditorCore(parent, initialValue, panelId, options);
  bindVimCoordination(core, options.readOnly === true);
  bindEditorCorePreferences(core, options.documentId ? () => options.documentId! : undefined);
  if (!options.readOnly) return { core, dispose: () => core.dispose() };
  const runtime = createReadingContributionHost(core, options.documentId || panelId, options.i18n);
  const { host, editor } = runtime, documentId = options.documentId || panelId;
  const roleCompartment = new Compartment();
  const roleExtensions = () => [
    roles({ readOnly: true, ...configuredEditorRoles() }),
    stickyUserHeaderView({
      prefixes: configuredEditorRoles().prefixes, enabled: () => boolean("dev.sticky-user-header.enabled"),
      subscribe: subscribeDisplayPreferences
    })
  ];
  core.addExternalExtension(roleCompartment.of(roleExtensions()));
  core.own(subscribeDisplayPreferences(key => {
    if (key === "*" || key.startsWith("zion.roles.") || key.startsWith("dev.roles."))
      core.view.dispatch({ effects: roleCompartment.reconfigure(roleExtensions()) });
  }));
  core.own(createChatOverviewRail(editor, { documentId, state: host.state, events: host.events, mirrorLegacy: false }));
  const outline = createConversationOutlineController({ subscriptions: [] }, host, {
    readOnly: true, translate: options.translate
  });
  core.own(outline);
  const provider = options.searchProvider;
  let query = new SearchQuery({ search: "" }), currentMatch: SurfaceSearchMatch | null = null;
  const getMatches = (text: string, searchOptions: ConversationSearchOptions) => {
    const result = computeConversationSearchMatches(provider?.text() ?? core.getValue(), text, searchOptions);
    const ranges: SurfaceSearchMatch[] = [...result.ranges, ...provider?.extra?.(text, searchOptions) || []].sort((a, b) => a.from - b.from);
    return { ...result, ranges };
  };
  const matches = () => getMatches(query.search, { caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, regex: query.regexp }).ranges;
  const navigate = (direction: number) => {
    if (!provider) return direction > 0 ? findNext(core.view) : findPrevious(core.view);
    const ranges = matches();
    if (!ranges.length) return false;
    const selected = core.view.state.selection.main;
    const index = currentMatch ? ranges.findIndex(match => match.from === currentMatch!.from && match.to === currentMatch!.to && match.cardId === currentMatch!.cardId) : -1;
    let next = index >= 0 ? (index + direction + ranges.length) % ranges.length
      : direction > 0 ? ranges.findIndex(match => match.from >= selected.to)
      : ranges.reduce((result, match, position) => match.to <= selected.from ? position : result, -1);
    if (next < 0) next = direction > 0 ? 0 : ranges.length - 1;
    const match = currentMatch = ranges[next];
    provider.reveal?.(match);
    core.view.dispatch({ selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: "center" }) });
    return true;
  };
  host.commands.registerCommand("setSearchQuery", (value: any) => {
    const next = new SearchQuery(value);
    if (!query.eq(next)) currentMatch = null;
    query = next;
    core.view.dispatch({ effects: setSearchQuery.of(query) });
  });
  host.commands.registerCommand("findNext", () => navigate(1));
  host.commands.registerCommand("findPrev", () => navigate(-1));
  host.commands.registerCommand("selectMatches", () => {
    if (!provider) return selectMatches(core.view);
    const ranges = matches(); if (!ranges.length) return false;
    ranges.forEach(match => provider.reveal?.(match));
    const selections = ranges.filter(match => !match.cardId);
    if (!selections.length) return navigate(1);
    core.view.dispatch({ selection: EditorSelection.create(selections.map(match => EditorSelection.range(match.from, match.to))) });
    return true;
  });
  const search = createConversationSearchController({ subscriptions: [] }, host, {
    readOnly: true, idPrefix: panelId === "public-reader" ? "" : panelId, translate: options.translate,
    ...(provider ? { matches: getMatches } : {})
  });
  core.own(search);
  runtime.installKeymap();
  return { core, outline, search, host, commands: host.commands, dispose: () => core.dispose() };
}
