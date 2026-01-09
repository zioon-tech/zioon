# Extensions API (zion-next)

This document summarizes the public extension API surfaced via `window.zion` and the related types in `src/types/zion.d.ts`. See the sample extensions under `extensions/dev.*`.

## Commands

- registerCommand(id: string, fn: (...args:any[]) => any): Disposable
- executeCommand<T = any>(id: string, ...args: any[]): T | undefined

Example:
```js
const d = zion.commands.registerCommand('hello.insertDate', () => {
  const ed = zion.window.activeEditor;
  if (ed) ed.replaceSelection(new Date().toISOString());
});
```

Note: Core also exposes theme commands:
- zion.setTheme(theme: 'light' | 'dark')
- zion.toggleTheme()

And WYSIWYG mode commands:
- zion.setWysiwyg(enabled: boolean)
- zion.toggleWysiwyg()

Editor runtime feature toggles:
- zion.setLineNumbers(enabled: boolean)
- zion.toggleLineNumbers()
- zion.setActiveLineHighlight(enabled: boolean)
- zion.toggleActiveLineHighlight()
- zion.setSyntaxHighlight(enabled: boolean)
- zion.toggleSyntaxHighlight()
- zion.setAutoIndent(enabled: boolean)
- zion.toggleAutoIndent()
- zion.setFolding(enabled: boolean)
- zion.toggleFolding()
- zion.setLineWrap(enabled: boolean)
- zion.toggleLineWrap()

## Keybindings

- register(binding: { command: string; key: string; when?: 'editorFocus' | 'hasSelection' | 'searchReplaceVisible' }): Disposable
- list(): Keybinding[]

Keybindings are merged into the editor keymap; `when` is evaluated at runtime.

## Menus

- register(menuId: string, item: { command: string; title?: string; when?: 'editorFocus' | 'hasSelection' }): Disposable
- show?(menuId: string, x: number, y: number): void

Currently supported menuId: `editor/context`. Items are filtered by `when` at open time.

## Messages pipeline

- registerContributor(contrib: {
  id: string;
  order?: number;   // default 50, smaller runs earlier
  stage?: 'pre' | 'post'; // default 'pre'
  contribute: (messages: any[], ctx: { editor: EditorProxy | null; state: any; events: any }) => any[] | Promise<any[]>;
}): Disposable

Use this to inject or transform messages before/after build.

## Events bus

- events.emit(topic: string, payload?: any): void
- events.on(topic: string, handler: (payload: any) => void): Disposable

Synchronous pub/sub for cross-extension communication.

## State bus

- state.get<T = unknown>(key: string): T | undefined
- state.set<T = unknown>(key: string, value: T): void
- state.update<T = unknown>(key: string, updater: (oldVal: T | undefined) => T): void
- state.onDidChange<T = unknown>(key: string, handler: (newVal: T | undefined, oldVal: T | undefined) => void): Disposable

Small shared KV store; use for lightweight shared states like selection, flags, etc.

Available shared keys:
- roles.index: { prefixes: string[]; blocks: { role: string; startLine: number; endLine?: number; from: number; to?: number; preview: string }[]; updatedAt: number }

Extensions can read user messages via:
- const idx = zion.state.get('roles.index');
- const users = (idx?.blocks || []).filter(b => b.role === 'user');

## Status bar

- statusBar.registerItem({ id: string; text: string; tooltip?: string; onClick?: () => void }): Disposable

Renders a right-top bar button (see `index.html`).

## Editor-level APIs

- editor.registerPasteHandler(handler: {
  id: string;
  priority?: number; // higher first, default 50
  handle(ctx: { clipboardData: DataTransfer; editor: EditorProxy }): boolean | Promise<boolean>;
}): Disposable

- editor.registerDecorator(dec: { id: string; apply(editor: EditorProxy): Disposable }): Disposable

- **editorProxy.addVisualExtension(ext: Extension): void**  
  > 通过 EditorProxy 注入自定义的 CM6 视觉扩展（如 ViewPlugin/Decoration），实现如角色区块、特殊高亮等效果。推荐用于角色高亮、块背景等场景。

Paste handlers run on editor DOM paste events in descending priority order. Returning true prevents default and short-circuits the chain. Decorators allow adding ephemeral behaviors/widgets; must return a Disposable.

## Models registry (placeholder)

- models.registerProvider(provider: {
  id: string;
  list(): ModelInfo[] | Promise<ModelInfo[]>;
  resolve(modelId: string): any | Promise<any>;
}): Disposable
- models.listProviders(): string[]
- models.getProvider(id: string): ModelProvider | null

Extensions can provide model catalogs and resolvers.

## EditorProxy methods

Exposed to extensions via `zion.window.activeEditor`:

- getValue(): string
- setValue(v: string): void
- replaceSelection(text: string): void
- getSelection(): string
- replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void
- getCursor(): { line: number; ch: number }
- setCursor(pos: { line: number; ch: number }): void
- focus(): void

Note: this is a safe wrapper over the internal editor; direct access to underlying CodeMirror is not exposed.

## WYSIWYG Markdown (Current Implementation)

**Note:**  
WYSIWYG Markdown is implemented as a core internal ViewPlugin for performance and stability.  
Extensions can only control WYSIWYG mode via the commands `zion.setWysiwyg(enabled)` and `zion.toggleWysiwyg()`.  
Direct replacement or mounting of visual rendering is **not supported**.  
The `editor.registerDecorator` API is for lightweight UI/behavior only and does **not** affect the core WYSIWYG rendering pipeline.

Zion Next now features a comprehensive WYSIWYG Markdown editor with the following capabilities:

### Block-level Elements
- **Headings**: Visual styling with proper font sizes, syntax markers hidden when not active
- **Lists**: 
  - Unordered lists with bullet points (•)
  - Ordered lists with styled numbers
  - Task lists with interactive checkboxes that toggle between `- [ ]` and `- [x]`
- **Quotes**: Visual styling with hidden `>` markers when not active
- **Code blocks**: Fenced code with syntax highlighting and diagram previews

### Advanced Widgets
- **Tables**: Fully editable tables with:
  - Cell content editing (contentEditable with real-time markdown sync)
  - Column resizing with drag handles
  - Alignment support (left/center/right)
  - Automatic markdown generation on changes
- **Diagrams**: 
  - Mermaid diagrams with theme-aware rendering
  - PlantUML diagrams with server-based rendering
  - Interactive toolbar: Edit, Copy SVG, Export PNG, Open in new window
  - Smart expansion/collapse based on cursor position
- **Math**: 
  - Inline math (`$...# Extensions API (zion-next)

This document summarizes the public extension API surfaced via `window.zion` and the related types in `src/types/zion.d.ts`. See the sample extensions under `extensions/dev.*`.

## Commands

- registerCommand(id: string, fn: (...args:any[]) => any): Disposable
- executeCommand<T = any>(id: string, ...args: any[]): T | undefined

Example:
```js
const d = zion.commands.registerCommand('hello.insertDate', () => {
  const ed = zion.window.activeEditor;
  if (ed) ed.replaceSelection(new Date().toISOString());
});
```

Note: Core also exposes theme commands:
- zion.setTheme(theme: 'light' | 'dark')
- zion.toggleTheme()

And WYSIWYG mode commands:
- zion.setWysiwyg(enabled: boolean)
- zion.toggleWysiwyg()

Editor runtime feature toggles:
- zion.setLineNumbers(enabled: boolean)
- zion.toggleLineNumbers()
- zion.setActiveLineHighlight(enabled: boolean)
- zion.toggleActiveLineHighlight()
- zion.setSyntaxHighlight(enabled: boolean)
- zion.toggleSyntaxHighlight()
- zion.setAutoIndent(enabled: boolean)
- zion.toggleAutoIndent()
- zion.setFolding(enabled: boolean)
- zion.toggleFolding()
- zion.setLineWrap(enabled: boolean)
- zion.toggleLineWrap()

## Keybindings

- register(binding: { command: string; key: string; when?: 'editorFocus' | 'hasSelection' | 'searchReplaceVisible' }): Disposable
- list(): Keybinding[]

Keybindings are merged into the editor keymap; `when` is evaluated at runtime.

## Menus

- register(menuId: string, item: { command: string; title?: string; when?: 'editorFocus' | 'hasSelection' }): Disposable
- show?(menuId: string, x: number, y: number): void

Currently supported menuId: `editor/context`. Items are filtered by `when` at open time.

## Messages pipeline

- registerContributor(contrib: {
  id: string;
  order?: number;   // default 50, smaller runs earlier
  stage?: 'pre' | 'post'; // default 'pre'
  contribute: (messages: any[], ctx: { editor: EditorProxy | null; state: any; events: any }) => any[] | Promise<any[]>;
}): Disposable

Use this to inject or transform messages before/after build.

## Events bus

- events.emit(topic: string, payload?: any): void
- events.on(topic: string, handler: (payload: any) => void): Disposable

Synchronous pub/sub for cross-extension communication.

## State bus

- state.get<T = unknown>(key: string): T | undefined
- state.set<T = unknown>(key: string, value: T): void
- state.update<T = unknown>(key: string, updater: (oldVal: T | undefined) => T): void
- state.onDidChange<T = unknown>(key: string, handler: (newVal: T | undefined, oldVal: T | undefined) => void): Disposable

Small shared KV store; use for lightweight shared states like selection, flags, etc.

Available shared keys:
- roles.index: { prefixes: string[]; blocks: { role: string; startLine: number; endLine?: number; from: number; to?: number; preview: string }[]; updatedAt: number }

Extensions can read user messages via:
- const idx = zion.state.get('roles.index');
- const users = (idx?.blocks || []).filter(b => b.role === 'user');

## Status bar

- statusBar.registerItem({ id: string; text: string; tooltip?: string; onClick?: () => void }): Disposable

Renders a right-top bar button (see `index.html`).

## Editor-level APIs

- editor.registerPasteHandler(handler: {
  id: string;
  priority?: number; // higher first, default 50
  handle(ctx: { clipboardData: DataTransfer; editor: EditorProxy }): boolean | Promise<boolean>;
}): Disposable

- editor.registerDecorator(dec: { id: string; apply(editor: EditorProxy): Disposable }): Disposable

- **editorProxy.addVisualExtension(ext: Extension): void**  
  > 通过 EditorProxy 注入自定义的 CM6 视觉扩展（如 ViewPlugin/Decoration），实现如角色区块、特殊高亮等效果。推荐用于角色高亮、块背景等场景。

Paste handlers run on editor DOM paste events in descending priority order. Returning true prevents default and short-circuits the chain. Decorators allow adding ephemeral behaviors/widgets; must return a Disposable.

## Models registry (placeholder)

- models.registerProvider(provider: {
  id: string;
  list(): ModelInfo[] | Promise<ModelInfo[]>;
  resolve(modelId: string): any | Promise<any>;
}): Disposable
- models.listProviders(): string[]
- models.getProvider(id: string): ModelProvider | null

Extensions can provide model catalogs and resolvers.

## EditorProxy methods

Exposed to extensions via `zion.window.activeEditor`:

- getValue(): string
- setValue(v: string): void
- replaceSelection(text: string): void
- getSelection(): string
- replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void
- getCursor(): { line: number; ch: number }
- setCursor(pos: { line: number; ch: number }): void
- focus(): void

Note: this is a safe wrapper over the internal editor; direct access to underlying CodeMirror is not exposed.

) using KaTeX
  - Block math (`$...$`) using KaTeX with display mode
- **Images & Links**: Preview widgets with proper attributes

### Inline Formatting
- **Bold** (`**text**`), *Italic* (`_text_`), `Code` (`` `text` ``), ~~Strikethrough~~ (`~~text~~`)
- Links and images with preview widgets
- All inline formatting preserves syntax markers when line is active (has cursor/selection)

### Performance & Architecture
- Incremental decoration updates using CodeMirror 6 ViewPlugin
- Viewport-based rendering for optimal performance
- Theme-aware rendering with MutationObserver for dynamic theme changes
- Compartment-based feature toggles for runtime customization

Extensions can control WYSIWYG via `zion.toggleWysiwyg()` and `zion.setWysiwyg(enabled)` commands. The implementation remains internal for performance and stability.

## Disposables

Most registration methods return a `Disposable` with `dispose()`. Always push disposables into your extension context and dispose them on deactivation.

## Example: Paste handler

```js
export function activate(ctx) {
  const disp = zion.editor.registerPasteHandler({
    id: 'demo.paste.timestamp',
    priority: 90,
    handle: ({ clipboardData, editor }) => {
      const text = clipboardData.getData('text/plain') || '';
      if (text.trim() === '::timestamp::') {
        editor.replaceSelection(new Date().toISOString());
        return true;
      }
      return false;
    }
  });
  ctx.subscriptions.push(disp);
}
```

## Example: Decorator

```js
export function activate(ctx) {
  const d = zion.editor.registerDecorator({
    id: 'demo.decorator.highlight',
    apply(editor) {
      // ... install behavior, setup listeners ...
      return { dispose() { /* cleanup */ } };
    }
  });
  ctx.subscriptions.push(d);
}
```

## Example: Visual Extension (roles block highlighting & folding)

```js
// roles.js (in your extension)
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { foldService } from "@codemirror/language";

// 注册角色区块高亮与自定义折叠服务
export function roles(opts = {}) {
  const prefixes = getEffectivePrefixes(opts);
  const foldExt = foldService.of((state, start) => {
    // 角色区块折叠：从角色行行尾到下一个角色行或文档末尾
    const doc = state.doc;
    const line = doc.lineAt(start);
    const text = doc.sliceString(line.from, line.to);
    const roleHere = getRoleForLine(text, prefixes);
    if (!roleHere) return null;
    const from = line.to;
    let to = doc.length;
    let pos = line.to + 1;
    while (pos <= doc.length) {
      const ln = doc.lineAt(pos);
      const t = doc.sliceString(ln.from, ln.to);
      const nextRole = getRoleForLine(t, prefixes);
      if (nextRole) {
        to = Math.max(from, ln.from - 1);
        break;
      }
      pos = ln.to + 1;
    }
    if (to <= from) return null;
    return { from, to };
  });
  return [foldExt, rolesView(opts)];
}

// main.js (extension entry)
export async function activate(ctx) {
  const { roles } = await import('./roles.js');
  const disp = window.zion.editor.registerDecorator({
    id: 'dev.roles.decorator',
    apply(editor) {
      editor.addVisualExtension(roles());
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(disp);
}
```

## Change tracking

When adding/changing APIs:
- Update this document
- Add tests in `tests/`
- Add an entry to `docs/Changelog.md` under “Unreleased”
- Consider an ADR for structural decisions