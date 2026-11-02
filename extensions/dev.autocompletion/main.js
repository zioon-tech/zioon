/**
 * dev.autocompletion
 *
 * Manages editor autocompletion state and commands.
 */
const I18N_NS = "dev.autocompletion";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.editor": "编辑器",
    "cmd.toggle": "编辑器：切换自动补全",
    "cmd.enable": "编辑器：启用自动补全",
    "cmd.disable": "编辑器：禁用自动补全",
    "ui.headerMenu": "自动补全"
  },
  "en-US": {
    "category.editor": "Editor",
    "cmd.toggle": "Editor: Toggle Autocompletion",
    "cmd.enable": "Editor: Enable Autocompletion",
    "cmd.disable": "Editor: Disable Autocompletion",
    "ui.headerMenu": "Autocompletion"
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
  const z = window.zion;
  try {
    const disp = z.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}
  
  // State management
  let autocompletionEnabled = (() => {
    try {
      const v = localStorage.getItem("zion.autocompletion");
      if (v === "0" || v === "false") return false;
      return true; // Default ON
    } catch {
      return true;
    }
  })();

  const applyAutocompletion = (enabled) => {
    autocompletionEnabled = !!enabled;
    try {
      localStorage.setItem("zion.autocompletion", enabled ? "1" : "0");
    } catch {}
    
    // Update global state
    z.state.set("editor.autocompletion", enabled);
    
    // Apply to current editor if exists
    const editor = z.window.activeEditor;
    if (editor && editor.core && typeof editor.core.setAutocompletionEnabled === 'function') {
      editor.core.setAutocompletionEnabled(enabled);
    }
  };

  // Register commands
  ctx.subscriptions.push(
    z.commands.registerCommand("editor.autocompletion.toggle", () => {
      applyAutocompletion(!autocompletionEnabled);
    })
  );

  ctx.subscriptions.push(
    z.commands.registerCommand("editor.autocompletion.enable", () => {
      applyAutocompletion(true);
    })
  );

  ctx.subscriptions.push(
    z.commands.registerCommand("editor.autocompletion.disable", () => {
      applyAutocompletion(false);
    })
  );

  // Listen to editor changes to re-apply setting when editor instance changes or is created
  ctx.subscriptions.push(
    z.events.on("editor.change", ({ view }) => {
      // This event fires frequently, maybe we should hook into 'editor.created' or similar if available?
      // Currently zion doesn't seem to have 'editor.created'.
      // However, we can check if the editor needs update.
      // But EditorCore is re-created on file open usually?
      // Wait, 'editor.change' is document change.
      
      // Actually, src/main.ts initializes EditorCore.
      // We need a way to apply settings when a new editor is attached.
      // But currently there is only one global editor instance in src/main.ts attached via `attachEditor`.
      // And `attachEditor` is called once.
      // However, if we want to support this properly, we should probably rely on `window.zion.window.activeEditor`.
      // The issue is: when this extension activates, the editor might already be there.
    })
  );

  // Apply initial state
  const editor = z.window.activeEditor;
  if (editor && editor.core && typeof editor.core.setAutocompletionEnabled === 'function') {
    editor.core.setAutocompletionEnabled(autocompletionEnabled);
  } else {
    // If editor not ready, retry in a moment (or wait for some event)
    setTimeout(() => {
        const editor = z.window.activeEditor;
        if (editor && editor.core && typeof editor.core.setAutocompletionEnabled === 'function') {
            editor.core.setAutocompletionEnabled(autocompletionEnabled);
        }
    }, 100);
  }

  // Register Header Menu Item
  try {
    const registry = z.__editorHeaderMenuRegistry;
    if (registry) {
      ctx.subscriptions.push(
        registry.register({
          id: "editor.autocompletion.headerMenu",
          title: t("ui.headerMenu", "Autocompletion"),
          section: t("category.editor", "Editor"),
          order: 20,
          kind: "toggle",
          getChecked: () => autocompletionEnabled,
          onClick: () => z.commands.executeCommand("editor.autocompletion.toggle")
        })
      );
    }
  } catch (e) {
    console.warn("[dev.autocompletion] Failed to register header menu item", e);
  }

  console.log("[dev.autocompletion] Activated");
}
