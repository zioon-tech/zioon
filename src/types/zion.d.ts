export type Disposable = { dispose(): void };

export type Keybinding = {
  command: string;
  key: string; // e.g., "Mod-Shift-D"
  when?: "editorFocus" | "hasSelection" | "searchReplaceVisible";
};

export type CommandHandler = (...args: any[]) => any;

export interface EditorProxy {
  getValue(): string;
  setValue(v: string): void;
  replaceSelection(text: string): void;
  getSelection(): string;
  replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void;
  getCursor(): { line: number; ch: number };
  setCursor(pos: { line: number; ch: number }): void;
  focus(): void;
  /** Inject a custom CM6 visual extension (e.g., ViewPlugin/Decoration) */
  addVisualExtension(ext: any): void;
}

export type PasteHandler = {
  id: string;
  priority?: number; // higher first, default 50
  handle(ctx: { clipboardData: DataTransfer; editor: EditorProxy }): boolean | Promise<boolean>;
};

export type MessageContributor = {
  id: string;
  order?: number; // default 50, smaller runs earlier
  stage?: "pre" | "post"; // default "pre"
  contribute: (messages: any[], ctx: { editor: EditorProxy | null; state: any; events: any }) => any[] | Promise<any[]>;
};

export type Decorator = {
  id: string;
  apply(editor: EditorProxy): Disposable;
};

export type MenuItem = {
  command?: string;
  title?: string;
  when?: "editorFocus" | "hasSelection";
  submenu?: MenuItem[];
  order?: number; // 默认 50，越小越靠前
  pinned?: boolean; // 是否置顶
  group?: string; // 分组标识，相同分组的可以一起拖拽
};

export type ModelInfo = { id: string; label?: string };
export type ModelProvider = {
  id: string;
  list(): ModelInfo[] | Promise<ModelInfo[]>;
  resolve(modelId: string): any | Promise<any>;
};

// Slash Commands
export type SlashParamType = 'string' | 'number' | 'boolean' | 'select';

export interface SlashParamSchema {
  name: string;
  type: SlashParamType;
  label: string;
  placeholder?: string;
  default?: any;
  min?: number; // for number
  max?: number; // for number
  options?: Array<{ value: string | number; label: string }>; // for select
  asyncOptions?: (params?: Record<string, any>) => Promise<Array<{ value: string | number; label: string }>>; // async options for select
}

export interface SlashCommand {
  id: string;
  trigger: string | string[]; // Single trigger string or array of triggers
  title: string;
  description?: string;
  category: string;
  icon?: string;
  aliases?: string[];
  priority?: number;
  params?: SlashParamSchema[];
  submenu?: any;
  execute: (params?: Record<string, any>, editor?: EditorProxy) => void | Promise<void>;
}

declare global {
  interface Window {
    zion: {
      // command system
      commands: {
        registerCommand(id: string, fn: CommandHandler): Disposable;
        executeCommand<T = any>(id: string, ...args: any[]): T | undefined;
      };
      // keybindings
      keybindings: {
        register(binding: Keybinding): Disposable;
        list(): Keybinding[];
      };
      // menus (context menus)
      menus: {
        register(menuId: string, item: MenuItem): Disposable;
        show?(menuId: string, x: number, y: number): void;
      };
      // messages pipeline contributors
      messages: {
        registerContributor(contrib: MessageContributor): Disposable;
      };
      // events bus
      events: {
        emit(topic: string, payload?: any): void;
        on(topic: string, handler: (payload: any) => void): Disposable;
      };
      // state bus
      state: {
        get<T = unknown>(key: string): T | undefined;
        set<T = unknown>(key: string, value: T): void;
        update<T = unknown>(key: string, updater: (oldVal: T | undefined) => T): void;
        onDidChange<T = unknown>(
          key: string,
          handler: (newVal: T | undefined, oldVal: T | undefined) => void
        ): Disposable;
      };
      // ui
      statusBar: {
        registerItem(opts: { id: string; text: string; tooltip?: string; onClick?: () => void }): Disposable;
      };
      // editor-level APIs
      editor: {
        registerPasteHandler(handler: PasteHandler): Disposable;
        registerDecorator(dec: { id: string; apply: (editor: EditorProxy) => Disposable }): Disposable;
      };
      // active editor
      window: {
        activeEditor: EditorProxy | null;
      };
      // models registry (placeholder)
      models?: {
        registerProvider(provider: ModelProvider): Disposable;
        listProviders(): string[];
        getProvider(id: string): ModelProvider | null;
      };
      // slash commands registry
      slash?: {
        registerCommand(cmd: SlashCommand): Disposable;
        getAllCommands(): SlashCommand[];
        getCommand(id: string): SlashCommand | undefined;
        executeCommand(id: string, params?: Record<string, any>): Promise<void>;
        onCommandsChanged(handler: () => void): Disposable;
      };
      chat?: {
        run(opts?: { useSelection?: boolean; prompt?: string }): void;
        stop(): void;
        retry(): void;
        setActiveModel(model: { providerId: string; modelId: string } | null): void;
        getActiveModel(): { providerId: string; modelId: string } | null;
      };
      // internal helper to refresh keymap after new bindings
      __applyKeymap?: () => void;
      // internal helpers (optional)
      __runMessageContributors?: (messages: any[], stage?: "pre" | "post") => Promise<any[]>;
    };
  }
}
export {};
