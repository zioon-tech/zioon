# Extensions Guide

Zion Next 通过 `window.zion` 暴露扩展 API，扩展无需修改核心代码，即可在运行时注册指令、快捷键、状态栏项，并通过事件与状态总线实现插件间互动。

## Manifest（extension.json）

```json
{
  "name": "publisher.my-ext",
  "version": "0.0.1",
  "main": "./main.js",
  "contributes": {
    "commands": [{ "id": "my.cmd", "title": "My Command" }],
    "keybindings": [{ "command": "my.cmd", "key": "Mod-Shift-m" }]
  },
  "activationEvents": ["onStartupFinished", "onCommand:my.cmd"]
}
```

- `name`：扩展名
- `main`：扩展入口模块（ESM）
- `contributes`：可声明命令和快捷键（后续会扩展菜单、状态栏等）
- `activationEvents`：激活事件（MVP 仅用于标识；实际加载由 `src/main.ts` 手动调用）

## 扩展入口（main.js）

```js
export async function activate(ctx) {
  // 注册命令
  const d1 = window.zion.commands.registerCommand("my.cmd", (...args) => {
    const ed = window.zion.window.activeEditor;
    ed?.replaceSelection("run my.cmd");
  });
  ctx.subscriptions.push(d1);

  // 注册快捷键
  const d2 = window.zion.keybindings.register({
    command: "my.cmd",
    key: "Mod-Shift-m"
  });
  ctx.subscriptions.push(d2);

  // 状态栏
  const status = window.zion.statusBar.registerItem({
    id: "my.status",
    text: "MyExt",
    tooltip: "Run my.cmd",
    onClick: () => window.zion.commands.executeCommand("my.cmd")
  });
  ctx.subscriptions.push(status);
}
```

- `ctx.subscriptions`：扩展资源收集（MVP 仅保存；后续停用时统一 dispose）

## API 参考（MVP）

- Commands
  ```ts
  window.zion.commands.registerCommand(id: string, fn: (...args) => any): Disposable
  window.zion.commands.executeCommand(id: string, ...args: any[]): any
  ```

- Keybindings
  ```ts
  window.zion.keybindings.register({ command, key, when? }): Disposable
  window.zion.keybindings.list(): Keybinding[]
  ```
  - 支持简单的 when 条件：
    - "editorFocus"：仅当编辑器聚焦时触发
    - "hasSelection"：仅当存在选区时触发
    - "searchReplaceVisible"：仅当搜索/替换面板可见且聚焦时触发（用于替换相关快捷键）

- Menus（Context menus）
  ```ts
  // 目前支持：'editor/context'
  window.zion.menus.register(menuId: "editor/context", item: { command, title?, when? }): Disposable
  ```
  - 扩展可以为编辑器右键菜单增加条目。
  - when 条件支持与 keybindings 相同的 "editorFocus" | "hasSelection"。

- StatusBar
  ```ts
  window.zion.statusBar.registerItem({ id, text, tooltip?, onClick? }): Disposable
  ```

- Decorators（轻量装饰器挂载点，MVP）
  ```ts
  // 在编辑器就绪后调用 apply，返回 Disposable 用于清理
  window.zion.editor.registerDecorator({
    id: "my.decorator",
    apply(editor) {
      // 在这里注入轻量 UI/监听（避免重度 DOM 操作）
      // 注意：此 API 仅用于添加轻量 UI/行为，不能替换或影响核心 WYSIWYG 渲染管线。
      // 返回的 Disposable 在禁用扩展或重载时会调用
      return { dispose() { /* 清理事件/DOM */ } };
    }
  });
  ```

- 视觉扩展（Visual Extension，推荐用于角色区块/高亮/折叠等）  
  推荐通过 editorProxy.addVisualExtension(ext) 注入自定义 ViewPlugin，实现如角色区块、用户内容高亮、**自定义折叠**等效果。  
  例如：
  ```js
  // roles.js
  import { RangeSetBuilder } from "@codemirror/state";
  import { Decoration, ViewPlugin } from "@codemirror/view";
  import { foldService } from "@codemirror/language";
  export function roles(opts = {}) {
    const prefixes = getEffectivePrefixes(opts);
    // 注册角色区块折叠服务
    const foldExt = foldService.of((state, start) => {
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

  // main.js
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
  > 角色区块、特殊高亮、区块折叠等视觉增强建议通过扩展实现，核心不再内置。

- Events Bus
  ```ts
  window.zion.events.emit(topic: string, payload?: any): void
  window.zion.events.on(topic: string, handler: (payload: any) => void): Disposable
  ```

- State Bus
  ```ts
  window.zion.state.get<T>(key: string): T | undefined
  window.zion.state.set<T>(key: string, value: T): void
  window.zion.state.update<T>(key: string, updater: (old: T | undefined) => T): void
  window.zion.state.onDidChange<T>(key: string, handler: (nv: T | undefined, ov: T | undefined) => void): Disposable
  ```

- Active Editor
  ```ts
  const ed = window.zion.window.activeEditor; // EditorProxy | null
  ed?.replaceSelection("text");
  ed?.getSelection();
  ed?.replaceRange("text", { line: 0, ch: 0 }, { line: 0, ch: 5 });
  ed?.getValue();
  ed?.setValue("new doc");
  ed?.getCursor();
  ed?.setCursor({ line, ch });
  ed?.focus();
  ```

## 模型提供者（Models，预留）

为了给后续“模型管理与调用”做好扩展位，提供最小的模型提供者注册表（当前仅注册/枚举/获取，暂未接入调用流程）。

- Models
  ```ts
  type ModelInfo = { id: string; label?: string }
  type ModelProvider = {
    id: string
    list(): ModelInfo[] | Promise<ModelInfo[]>
    resolve(modelId: string): any | Promise<any> // 返回该模型的配置或客户端实例
  }

  // 注册与查询
  zion.models.registerProvider(provider: ModelProvider): Disposable
  zion.models.listProviders(): string[]               // ['my.provider', ...]
  zion.models.getProvider(id: string): ModelProvider | null
  ```

> 说明：当前仅用于扩展自注册与调试，后续版本会把模型选择器与 chat 适配器接入该注册表。

- 示例（简版）
  ```js
  // extensions/dev.sample-models/main.js
  export async function activate(ctx) {
    const disp = zion.models.registerProvider({
      id: 'demo.models',
      async list() { return [{ id: 'demo:gpt-small', label: 'Demo GPT Small' }]; },
      async resolve(id) { return { id, baseUrl: 'https://api.demo.local', apiKey: 'demo-key' }; }
    });
    ctx.subscriptions.push(disp);
  }
  ```

## 粘贴处理器（Paste Handlers）

扩展可拦截编辑器的粘贴事件，并在满足条件时替换默认粘贴行为。

```js
export async function activate(ctx) {
  // 当剪贴板纯文本等于 "::timestamp::" 时，插入时间戳并阻止默认粘贴
  const disp = window.zion.editor.registerPasteHandler({
    id: "demo.paste.timestamp",
    priority: 90, // 越大越先处理，默认 50
    handle: ({ clipboardData, editor }) => {
      const text = clipboardData.getData("text/plain") || "";
      if (text.trim() === "::timestamp::") {
        editor.replaceSelection(new Date().toISOString());
        return true; // 已处理
      }
      return false; // 未处理，交给后续或默认
    }
  });
  ctx.subscriptions.push(disp);
}
```

> 注意：一旦某个处理器返回 `true`，默认粘贴会被 `preventDefault()`。

- 高级示例：JSON -> YAML、URL 自动转链接
  ```js
  export async function activate(ctx) {
    // 1) JSON 文本自动转换为 YAML
    const toYAML = (obj, indent = 0) => {
      const sp = '  '.repeat(indent);
      if (obj === null) return 'null';
      if (typeof obj !== 'object') return typeof obj === 'string' ? JSON.stringify(obj) : String(obj);
      if (Array.isArray(obj)) return obj.map(v => `${sp}- ${toYAML(v, indent + 1).trimStart()}`).join('\n');
      return Object.keys(obj).map(k => {
        const v = obj[k];
        if (typeof v === 'object' && v !== null) return `${sp}${k}:\n${toYAML(v, indent + 1)}`;
        return `${sp}${k}: ${toYAML(v, indent + 1)}`;
      }).join('\n');
    };

    const h1 = zion.editor.registerPasteHandler({
      id: 'demo.paste.json2yaml',
      priority: 80,
      handle: ({ clipboardData, editor }) => {
        const text = clipboardData.getData('text/plain') || '';
        if (!/^[\s\r\n]*[\{\[]/.test(text.trim())) return false;
        try {
          const yaml = toYAML(JSON.parse(text));
          editor.replaceSelection(yaml);
          return true;
        } catch { return false; }
      }
    });
    ctx.subscriptions.push(h1);

    // 2) 纯 URL 文本自动转成 Markdown 链接
    const h2 = zion.editor.registerPasteHandler({
      id: 'demo.paste.url2link',
      priority: 70,
      handle: ({ clipboardData, editor }) => {
        const t = (clipboardData.getData('text/plain') || '').trim();
        if (!/^https?:\/\/\S+$/i.test(t)) return false;
        const title = t.replace(/^https?:\/\/(www\.)?/, '').slice(0, 64);
        editor.replaceSelection(`[${title}](${t})`);
        return true;
      }
    });
    ctx.subscriptions.push(h2);
  }
  ```

## 加载扩展与扩展管理

- 开发与构建环境下会自动扫描并加载 `/extensions/**/extension.json`。  
  将你的扩展放在 `extensions/your-ext/` 目录中，无需修改代码即可生效。
- 顶部状态栏提供“Extensions”按钮，可打开扩展面板：
  - 在面板中可启用/禁用单个扩展（状态保存在 localStorage，刷新后生效）。
  - 扩展加载失败时，状态栏会显示 `● ExtErr(n)` 提示，详细错误请查看控制台。

> 仍保留 `loadExtension(manifestPath)` 以便特殊场景按路径加载单个扩展。

## 插件间互动

- 使用事件总线进行解耦通信：
  - Explorer 发布 `bookmark/requestAdd`，BookmarkBar 监听并添加
- 使用状态总线共享小型快照：
  - Explorer 写入 `explorer.selectedFiles`，其他插件监听变化

这两者都无需互相 import，边界清晰、易维护。

## 扩展变更记录与版本兼容

- 当扩展依赖的 API（如 `messages.registerContributor`、`menus.register`、`editor.registerPasteHandler`、`editor.registerDecorator`）新增或变更时：
  - 在 docs/Changelog.md 的 “Unreleased” 中记录，并简要说明改动影响范围与示例。
  - 在本文件（Extensions.md）相应 API 小节同步更新签名/示例。
- WYSIWYG 渲染暂不开放扩展挂载点，扩展仅能通过命令控制开关。如后续开放 editor.registerVisualExtension 等能力，需在 Changelog/Extensions.md 明确记录。
- 兼容建议
  - 扩展在激活时可检测 API 是否存在（例如 `if (!window?.zion?.messages) ...`），以便在旧版本核心上降级或给出提示。
  - 避免依赖未公开的内部实现（如底层 CM6/EditorCore 实例），仅使用 EditorProxy 公开方法。
- 视觉增强建议
  - 角色区块、特殊高亮等视觉增强建议通过扩展实现（如 dev.roles），不建议直接修改内核。
  - 推荐通过 editorProxy.addVisualExtension(ext) 注入 ViewPlugin，样式通过全局 CSS 变量和类名自定义。
- 版本策略
  - 对扩展开发者：当依赖的 API 发生破坏性变更（Breaking），建议在扩展 README 中注明支持的核心版本范围，并在扩展入口做版本检查。
  - 对核心维护：在 docs/Changelog.md 中标明 Breaking，并给出迁移指南链接。

## 扩展主题与样式（Theming）

- 默认跟随主题：扩展 UI 请使用全局 CSS 变量 var(--panel)、var(--border)、var(--fg)、var(--accent)。
- 自定义覆盖：扩展可使用自定义变量并提供回退，例如：
  - 面板背景：`var(--ext-toc-bg, var(--panel))`
  - 文字颜色：`var(--ext-toc-fg, var(--fg))`
  - 边框/强调色：`var(--ext-toc-border, var(--border))`、`var(--ext-toc-accent, var(--accent))`
- 示例：
  - dev.toc 使用 `--ext-toc-*` 变量支持定制；
  - dev.decorator-hello 使用 `--ext-hello-*` 变量支持定制。
- 使用方式：在全局样式或用户主题中定义这些 `--ext-xxx-*` 变量，即可针对某扩展定制配色；未定义时自动回退到当前 Light/Dark 主题。

=======