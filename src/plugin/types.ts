/**
 * 插件系统类型定义
 */

/**
 * 可销毁对象
 */
export interface Disposable {
  dispose(): void;
}

/**
 * 插件状态
 */
export type PluginState = 
  | 'installed'    // 已安装但未启用
  | 'enabled'      // 已启用但未激活
  | 'disabled'     // 已禁用
  | 'activating'   // 正在激活
  | 'active'       // 已激活
  | 'deactivating' // 正在停用
  | 'error'        // 错误状态
  | 'uninstalled'; // 已卸载

export type PluginOrigin = 'builtin' | 'dev' | 'external';

export interface PluginDevSessionRecord {
  pluginId: string;
  devId: string;
  baseUrl: string;
  dir: string;
}

/**
 * 插件错误类型
 */
export type PluginErrorType = 
  | 'load_failed'      // 加载失败
  | 'activation_failed' // 激活失败
  | 'dependency_failed' // 依赖失败
  | 'validation_failed' // 验证失败
  | 'runtime_error'    // 运行时错误
  | 'sandbox_error'    // 沙箱错误
  | 'permission_error' // 权限错误
  | 'unknown_error';   // 未知错误

/**
 * 插件错误
 */
export interface PluginError {
  type: PluginErrorType;
  message: string;
  stack?: string;
  pluginId?: string;
  timestamp: number;
}

/**
 * 插件清单（新格式）
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  zion: {
    id: string;
    name: string;
    version: string;
    main: string;
    presentation?: {
      displayName?: string | Record<string, string>;
      description?: string | Record<string, string>;
      icon?: string;
      category?: string;
      features?: string[] | Record<string, string[]>;
      permissions?: Array<{
        id: string;
        label: string | Record<string, string>;
        description?: string | Record<string, string>;
      }>;
      dataLocations?: Array<{
        label: string | Record<string, string>;
        path: string;
      }>;
      entrypoints?: Array<{
        title: string | Record<string, string>;
        command: string;
        icon?: string;
      }>;
    };
    contributes?: {
      commands?: Array<{
        id: string;
        title: string;
        description?: string;
      }>;
      keybindings?: Array<{
        command: string;
        key: string;
        when?: string;
      }>;
      menus?: Array<{
        location: string;
        command: string;
        title: string;
        when?: string;
      }>;
      views?: Array<{
        id: string;
        title: string;
        type: 'sidebar' | 'panel' | 'statusbar';
        icon?: string;
      }>;
      themes?: Array<{
        id: string;
        label: string;
        uiTheme: 'vs-dark' | 'vs-light';
        path: string;
      }>;
      styles?: string[];
      skills?: string[];
      languages?: Array<{
        id: string;
        extensions: string[];
        aliases: string[];
      }>;
    };
    activationEvents?: string[];
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    engines?: {
      zion: string;
    };
  };
}

/**
 * 扩展清单（旧格式 - 已废弃）
 */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main?: string;
  presentation?: PluginManifest['zion']['presentation'];
  commands?: Record<string, {
    title?: string;
    handler: (...args: any[]) => any;
  }>;
  keybindings?: Array<{
    command: string;
    key: string;
    when?: string;
  }>;
  menus?: Record<string, Array<{
    command: string;
    title?: string;
    when?: string;
  }>>;
  statusBar?: Array<{
    id: string;
    text: string;
    tooltip?: string;
    onClick?: () => void;
  }>;
  pasteHandlers?: Array<{
    id: string;
    priority?: number;
    handle: (ctx: { clipboardData: DataTransfer; editor: any }) => boolean | Promise<boolean>;
  }>;
  decorators?: Array<{
    id: string;
    apply: (editor: any) => Disposable;
  }>;
}

/**
 * 插件信息
 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  path: string;
  manifest: PluginManifest | ExtensionManifest;
  state: PluginState;
  error?: PluginError;
  dependencies: string[];
  peerDependencies: string[];
  createdAt: number;
  updatedAt: number;
  isLegacy: boolean;
  /** 插件来源：内置扩展、开发目录或外部分发包 */
  origin?: PluginOrigin;
  /** 是否启用（UI/管理器用） */
  enabled?: boolean;
  /** ZIP 插件中由 contributes.skills 声明的 SKILL.md 内容 */
  skillContents?: Record<string, string>;
  /** ZIP/开发插件中由 contributes.skills 声明的技能目录文本文件 */
  skillFiles?: Record<string, Record<string, string>>;
  /** ZIP 插件中由 contributes.styles 声明的样式内容 */
  styleContents?: Record<string, string>;
  /** 开发模式插件的本地源码目录 */
  sourceDir?: string;
  /** 开发模式插件会话 ID */
  devId?: string;
}

/**
 * 插件模块
 */
export interface PluginModule {
  activate?: (context: PluginContext) => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
  [key: string]: any;
}

/**
 * 插件上下文
 */
export interface PluginContext {
  subscriptions: Disposable[];
  extensionPath: string;
  globalState: Memento;
  workspaceState: Memento;
  configuration: PluginConfigurationManager;
  asAbsolutePath(path: string): string;
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error'): void;
}

/**
 * 状态存储接口
 */
export interface Memento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: any): Promise<void>;
  keys(): string[];
}

/**
 * 插件配置管理器
 */
export interface PluginConfigurationManager {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: any): Promise<void>;
  onDidChange(key: string, callback: (value: any) => void): Disposable;
}

/**
 * 插件安装选项
 */
export interface PluginInstallOptions {
  force?: boolean;
  skipDependencies?: boolean;
  skipValidation?: boolean;
}

/**
 * 插件事件类型
 */
export type PluginEventType =
  | 'installed'
  | 'uninstalled'
  | 'updated'
  | 'hotReloaded'
  | 'enabled'
  | 'disabled'
  | 'activated'
  | 'deactivated'
  | 'error';

/**
 * 插件事件
 */
export interface PluginEvent {
  type: PluginEventType;
  plugin: PluginInfo;
  timestamp: number;
  error?: PluginError;
}

/**
 * 插件统计信息
 */
export interface PluginStats {
  total: number;
  active: number;
  enabled: number;
  disabled: number;
  errors: number;
  legacy: number;
  memoryUsage: number;
  loadTime: number;
}

/**
 * 插件依赖图
 */
export interface PluginDependencyGraph {
  nodes: Map<string, PluginInfo>;
  edges: Map<string, string[]>;
  cycles: string[][];
}

/**
 * 插件加载器选项
 */
export interface PluginLoaderOptions {
  sandbox?: boolean;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  timeout?: number;
}

/**
 * 插件验证结果
 */
export interface PluginValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest?: PluginManifest | ExtensionManifest;
}

/**
 * 插件包信息
 */
export interface PluginPackageInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  zion?: {
    id: string;
    name: string;
    version: string;
    main: string;
  };
}

/**
 * 插件市场信息
 */
export interface PluginMarketInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  rating: number;
  updatedAt: number;
  tags: string[];
  homepage?: string;
  repository?: string;
  license?: string;
}

/**
 * 插件搜索选项
 */
export interface PluginSearchOptions {
  query?: string;
  tags?: string[];
  author?: string;
  minRating?: number;
  minDownloads?: number;
  limit?: number;
  offset?: number;
}

/**
 * 插件安装结果
 */
export interface PluginInstallResult {
  success: boolean;
  plugin?: PluginInfo;
  error?: PluginError;
  warnings: string[];
}

/**
 * 插件更新结果
 */
export interface PluginUpdateResult {
  success: boolean;
  plugin?: PluginInfo;
  oldVersion?: string;
  newVersion?: string;
  error?: PluginError;
}

/**
 * 插件激活结果
 */
export interface PluginActivationResult {
  success: boolean;
  plugin?: PluginInfo;
  error?: PluginError;
  warnings: string[];
}

/**
 * 插件停用结果
 */
export interface PluginDeactivationResult {
  success: boolean;
  plugin?: PluginInfo;
  error?: PluginError;
}

/**
 * 插件依赖解析结果
 */
export interface PluginDependencyResolution {
  resolved: Map<string, string>;
  conflicts: Array<{ pluginId: string; dependency: string; required: string; installed: string }>;
  missing: string[];
  cycles: string[][];
}

/**
 * 插件沙箱选项
 */
export interface PluginSandboxOptions {
  allowNetwork?: boolean;
  allowFileSystem?: boolean;
  allowDom?: boolean;
  allowEval?: boolean;
  timeout?: number;
  memoryLimit?: number;
}

/**
 * 插件沙箱环境
 */
export interface PluginSandboxEnvironment {
  iframe: HTMLIFrameElement;
  window: Window;
  document: Document;
  console: Console;
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
  fetch?: typeof fetch;
  localStorage?: Storage;
  sessionStorage?: Storage;
}

/**
 * 插件沙箱API
 */
export interface PluginSandboxAPI {
  commands: {
    registerCommand: (id: string, handler: (...args: any[]) => any) => Disposable;
    executeCommand: (id: string, ...args: any[]) => Promise<any>;
  };
  events: {
    on: (event: string, handler: (...args: any[]) => void) => Disposable;
    emit: (event: string, ...args: any[]) => void;
  };
  state: {
    get: <T>(key: string, defaultValue?: T) => T | undefined;
    set: <T>(key: string, value: T) => Promise<void>;
    onDidChange: <T>(key: string, callback: (value: T) => void) => Disposable;
  };
  ui: {
    registerView: (id: string, options: any) => Disposable;
    showNotification: (message: string, type?: 'info' | 'warn' | 'error') => void;
  };
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
  };
  http?: {
    fetch: (url: string, options?: RequestInit) => Promise<Response>;
  };
}
