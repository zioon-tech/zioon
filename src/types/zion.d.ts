export type Disposable = { dispose(): void };

export type Keybinding = {
  command: string;
  key: string; // e.g., "Mod-Shift-D"
  when?: "editorFocus" | "hasSelection" | "searchReplaceVisible";
};

export type CommandHandler = (...args: any[]) => any;

export interface EditorProxy {
  panelId?: string | null;
  editorId?: string;
  sessionId?: string | null;
  getValue(): string;
  setValue(v: string, opts?: { source?: "session-load" }): void;
  replaceSelection(text: string): void;
  getSelection(): string;
  replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void;
  getCursor(): { line: number; ch: number };
  setCursor(pos: { line: number; ch: number }): void;
  focus(): void;
  setSessionId?(sessionId: string | null): void;
  /** Inject a custom CM6 visual extension (e.g., ViewPlugin/Decoration) */
  addVisualExtension(ext: any): void;
  /** Get raw CM6 EditorView for advanced extensions */
  getView(): any;
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

export type MemoryItem = {
  id: string;
  providerId?: string;
  path?: string;
  title: string;
  content: string;
  layer?: "working" | "long-term" | string;
  type?: "semantic" | "episodic" | "procedural" | "preference" | string;
  scope?: "user" | "project" | "workspace" | "agent" | string;
  tags?: string[];
  enabled?: boolean;
  pinned?: boolean;
  confidence?: number;
  source?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type MemoryProvider = {
  id: string;
  label?: string;
  kind?: "local" | "external" | string;
  writable?: boolean;
  disabled?: boolean;
  description?: string;
  capabilities?: string[];
  list?: () => MemoryItem[] | Promise<MemoryItem[]>;
  search?: (query: string, opts?: any) => MemoryItem[] | Promise<MemoryItem[]>;
  read?: (id: string) => MemoryItem | null | Promise<MemoryItem | null>;
  write?: (item: Partial<MemoryItem>) => MemoryItem | Promise<MemoryItem>;
  delete?: (id: string) => boolean | Promise<boolean>;
};

export type MenuItem = {
  command?: string;
  title?: string;
  when?: "editorFocus" | "hasSelection";
  submenu?: MenuItem[];
  order?: number; // 默认 50，越小越靠前
  pinned?: boolean; // 是否置顶
  group?: string; // 分组标识，相同分组的可以一起拖拽
  /** If provided, called when building the menu to compute the title dynamically */
  dynamicTitle?: () => string | null;
};

export type SelectionToolbarContext = {
  view: any;
  selectionText: string;
  from: number;
  to: number;
};

export type SelectionToolbarItem = {
  id: string;
  order?: number;
  title?: string;
  label?: string;
  codicon?: string;
  when?: (ctx: SelectionToolbarContext) => boolean;
  run?: (ctx: SelectionToolbarContext & { anchorEl: HTMLElement; event?: Event }) => void;
  render?: (ctx: SelectionToolbarContext & { anchorEl: HTMLElement; event?: Event }) => HTMLElement;
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
        list(): string[];
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
        registerItem(opts: { id: string; text: string; tooltip?: string; onClick?: () => void; priority?: number; align?: "left" | "right" }): Disposable;
      };
      settings?: {
        registerPage(page: any): Disposable;
        registerItem(item: any): Disposable;
        open(): void;
        close(): void;
      };
      memory?: {
        registerProvider(provider: MemoryProvider): Disposable;
        listProviders(): MemoryProvider[];
        listMemories(): MemoryItem[];
        getMemory(id: string): MemoryItem | null;
        getMemoryByPath(path: string): MemoryItem | null;
        getRootPath(): string;
        createMemory(input?: Partial<MemoryItem>): MemoryItem;
        updateMemory(id: string, patch: Partial<MemoryItem>): MemoryItem | null;
        deleteMemory(id: string): void;
        search(query?: string, opts?: any): MemoryItem[];
        buildContext(query?: string, opts?: any): { text: string; items: MemoryItem[]; maxChars: number };
        importMarkdown(markdown: string, opts?: Partial<MemoryItem>): MemoryItem;
        exportMarkdown(items?: MemoryItem[]): string;
        getSettings(): Record<string, any>;
        saveSettings(patch: Record<string, any>): Record<string, any>;
        setActiveMemory(id: string): void;
        openMemory(id: string): void;
        getActiveMemory(): MemoryItem | null;
      };
      i18n?: {
        getLocale(): "zh-CN" | "en-US";
        getDefaultLocale(): "zh-CN";
        getSupportedLocales(): Array<{ value: "zh-CN" | "en-US"; label: string; nativeLabel: string }>;
        setLocale(locale: "zh-CN" | "en-US"): void;
        toggleLocale(): void;
        registerNamespace(
          namespace: string,
          messages: Partial<Record<"zh-CN" | "en-US", Record<string, string>>>
        ): Disposable;
        t(key: string, values?: Record<string, string | number | boolean | null | undefined>): string;
        getMessageVariants(key: string, values?: Record<string, string | number | boolean | null | undefined>): string[];
      };
      theme?: {
        getPreference(): "system" | "light" | "dark";
        getSelection(): "system" | "light" | "dark" | "visual-studio-dark" | "github-dark" | "github-light" | "catppuccin-mocha" | "catppuccin-latte" | "tokyo-night" | "rose-pine-dawn" | "everforest-light" | "kanagawa-lotus";
        getResolvedTheme(): "light" | "dark";
        getVariant(): "default" | "visual-studio-dark" | "github-dark" | "github-light" | "catppuccin-mocha" | "catppuccin-latte" | "tokyo-night" | "rose-pine-dawn" | "everforest-light" | "kanagawa-lotus";
        setPreference(preference: "system" | "light" | "dark"): void;
        setSelection(selection: "system" | "light" | "dark" | "visual-studio-dark" | "github-dark" | "github-light" | "catppuccin-mocha" | "catppuccin-latte" | "tokyo-night" | "rose-pine-dawn" | "everforest-light" | "kanagawa-lotus"): void;
        setVariant(variant: "default" | "visual-studio-dark" | "github-dark" | "github-light" | "catppuccin-mocha" | "catppuccin-latte" | "tokyo-night" | "rose-pine-dawn" | "everforest-light" | "kanagawa-lotus"): void;
        toggle(): void;
        refresh(): void;
        getToken(name: string): string;
      };
      editorHeaderMenu?: {
        register(item: {
          id: string;
          title?: string;
          section?: string;
          order?: number;
          kind?: "action" | "toggle" | "separator";
          command?: string;
          args?: any[];
          onClick?: () => void;
          getChecked?: () => boolean;
        }): Disposable;
        list(): Array<{
          id: string;
          title?: string;
          section?: string;
          order?: number;
          kind?: "action" | "toggle" | "separator";
        }>;
      };
      activityBar?: {
        registerItem(opts: {
          id: string;
          pluginId: string;
          icon: string;
          tooltip?: string;
          tooltipKey?: string;
          order?: number;
          when?: string;
          sideBarViewId?: string;
          auxiliaryBarViewId?: string;
          bottomPanelViewId?: string;
          onClick?: () => void;
        }): Disposable;
        activateItem(id: string): void;
        getItems(): any[];
        show(): void;
        hide(): void;
        toggle(): boolean;
      };
      sideBar?: {
        registerView(opts: {
          id: string;
          pluginId: string;
          title: string;
          titleKey?: string;
          icon?: string;
          location?: 'sidebar' | string;
          order?: number;
          when?: string;
          canClose?: boolean;
          headerActions?: Array<{ id: string; title: string; titleKey?: string; ariaLabel?: string; ariaLabelKey?: string; icon?: string; onClick: () => void }>;
          component: {
            render: (container: HTMLElement) => { dispose?: () => void } | void;
          };
          onActivate?: () => void | Promise<void>;
          onDeactivate?: () => void | Promise<void>;
          onResize?: (size: { width: number; height: number }) => void;
          onDispose?: () => void;
        }): Disposable;
        activateView(id: string): void;
        getViews(): any[];
        show(): void;
        hide(): void;
        toggle(): boolean;
        setWidth(w: number): void;
      };
      auxiliaryBar?: {
        registerView(opts: {
          id: string;
          pluginId: string;
          title: string;
          titleKey?: string;
          icon?: string;
          location?: 'auxiliarybar' | string;
          order?: number;
          when?: string;
          canClose?: boolean;
          keepWhenActive?: boolean;
          headerActions?: Array<{ id: string; title: string; titleKey?: string; ariaLabel?: string; ariaLabelKey?: string; icon?: string; onClick: () => void }>;
          component: {
            render: (container: HTMLElement) => { dispose?: () => void } | void;
          };
          onActivate?: () => void | Promise<void>;
          onDeactivate?: () => void | Promise<void>;
          onResize?: (size: { width: number; height: number }) => void;
          onDispose?: () => void;
        }): Disposable;
        activateView(id: string): void;
        closeView(id: string): void;
        getViews(): any[];
        show(): void;
        hide(): void;
        toggle(): boolean;
        setWidth(w: number): void;
      };
      bottomPanel?: {
        registerView(opts: {
          id: string;
          pluginId: string;
          title: string;
          titleKey?: string;
          icon?: string;
          location?: 'bottompanel' | string;
          order?: number;
          when?: string;
          keepWhenActive?: boolean;
          maximizable?: boolean;
          component: {
            render: (container: HTMLElement) => { dispose?: () => void } | void;
          };
          onActivate?: () => void | Promise<void>;
          onDeactivate?: () => void | Promise<void>;
          onResize?: (size: { width: number; height: number }) => void;
          onDispose?: () => void;
        }): Disposable;
        activateView(id: string): void;
        closeView(id: string): void;
        getViews(): any[];
        show(): void;
        hide(): void;
        toggle(): boolean;
        setHeight(h: number): void;
        maximize(): void;
        restore(): void;
      };
      responsive?: {
        getCurrentDeviceType(): 'mobile' | 'tablet' | 'desktop' | 'largedesktop';
        getCurrentMode(): 'compact' | 'medium' | 'full' | 'split';
        getScreenWidth(): number;
        getScreenHeight(): number;
        isMobile(): boolean;
        isTablet(): boolean;
        isDesktop(): boolean;
        onDidChangeDeviceType(callback: (deviceType: 'mobile' | 'tablet' | 'desktop' | 'largedesktop') => void): Disposable;
        onDidChangeMode(callback: (mode: 'compact' | 'medium' | 'full' | 'split') => void): Disposable;
        setMode(mode: 'compact' | 'medium' | 'full' | 'split'): void;
      };
      // editor-level APIs
      editor: {
        registerPasteHandler(handler: PasteHandler): Disposable;
        registerDecorator(dec: { id: string; apply: (editor: EditorProxy) => Disposable }): Disposable;
        attachEditor?(core: any, panelId?: string): EditorProxy | null;
        detachEditor?(panelId: string): EditorProxy | null;
        listAttachedEditorCores?(): any[];
        getEditorForView?(view: any): EditorProxy | null;
        selectionToolbar?: {
          registerItem(item: SelectionToolbarItem): Disposable;
          list(): SelectionToolbarItem[];
          onDidChange(handler: () => void): Disposable;
        };
      };
      // active editor
      window: {
        activeEditor: EditorProxy | null;
      };
      panels?: {
        getActivePanelId(): string | null;
        getMaximizedPanelId(): string | null;
        isMaximized(panelId?: string): boolean;
        list(): Array<{ id: string; activeTabId: string | null }>;
        findAtSide(side: "left" | "right" | "up" | "down", panelId?: string): string | null;
        ensureAtSide(side: "left" | "right" | "up" | "down", panelId?: string): string | null;
        openSession(panelId: string, sessionId: string, opts?: { focus?: boolean; forceReload?: boolean }): boolean | Promise<boolean>;
        openTab?(panelId: string, tabId: string, opts?: { focus?: boolean }): boolean | Promise<boolean>;
        openFileTab?(args: { panelId?: string; id?: string; title?: string; name?: string; path?: string; displayPath?: string; language?: string; meta?: any; file?: any; focus?: boolean }): boolean | Promise<boolean>;
        split(direction: "horizontal" | "vertical", panelId?: string): string | null;
        splitAt(side: "left" | "right" | "up" | "down", panelId?: string): string | null;
        focus(panelId: string): void;
        close(panelId?: string): void;
        maximize(panelId?: string): void;
        restore(): void;
        toggleMaximize(panelId?: string): void;
        getEditor(panelId: string): EditorProxy | null;
        getEditorBySession(panelId: string, sessionId: string): EditorProxy | null;
        listEditors(panelId?: string): Array<{ panelId: string; sessionId: string; editorId: string | null; active: boolean }>;
      };
      sessions?: {
        runtime?: any;
        resolveContext(opts?: { panelId?: string | null; sessionId?: string | null; editor?: EditorProxy | null }): {
          panelId: string | null;
          sessionId: string | null;
          editor: EditorProxy | null;
          panel: any | null;
        };
        getPanelSessionId(panelId: string): string | null;
        isEditorShowingSession(editor: EditorProxy | null, sessionId: string | null): boolean;
      };
      // models registry (placeholder)
      models?: {
        registerProvider(provider: ModelProvider): Disposable;
        listProviders(): string[];
        getProvider(id: string): ModelProvider | null;
      };
      llm?: {
        runStream(opts: {
          messages: any[];
          tools?: any;
          onToken?: (token: any) => void;
          onEnd?: () => void;
          onError?: (error: any) => void;
          getController?: (controller: any) => void;
          onToolCall?: (toolCall: any) => void;
          runId?: string;
          sessionId?: string;
          activeModel?: { providerId: string; modelId: string; label?: string } | null;
          silentReasoning?: boolean;
        }): Promise<any>;
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
        run(opts?: { useSelection?: boolean; prompt?: string; sessionId?: string; panelId?: string; editor?: EditorProxy | null }): void;
        stop(sessionId?: string): void;
        retry(sessionId?: string): void;
        isStreaming(sessionId?: string): boolean;
        setActiveModel(model: { providerId: string; modelId: string } | null): void;
        getActiveModel(): { providerId: string; modelId: string } | null;
      };
      agents?: {
        listTasks(): any[];
        getTask(id: string): any | null;
        getTasksForSession(sessionId?: string | null): any[];
        getExecutionPlan(task: any): any;
        isRunning(id: string): boolean;
        runTask(id: string, handle?: any): Promise<void> | null;
        stopTask(id: string): void | null;
        createTask(task: any): any;
        updateTask(id: string, patch: any): any | null;
        deleteTask(id: string): void;
        revealTask(id: string, opts?: any): boolean;
        openPanel(): void;
        listAgents(): any[];
        getAgent(id: string): any;
      };
      notification?: {
        show(message: string, options?: {
          type?: 'info' | 'success' | 'warning' | 'error';
          duration?: number;
          dismissible?: boolean;
          actions?: Array<{ label: string; handler: () => void }>;
        }): HTMLElement;
      };
      // internal helper to refresh keymap after new bindings
      __applyKeymap?: () => void;
      // internal helpers (optional)
      __runMessageContributors?: (messages: any[], stage?: "pre" | "post") => Promise<any[]>;
    };
  }
}
export {};
