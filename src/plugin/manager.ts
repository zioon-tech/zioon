/**
 * 插件管理器
 * 负责插件的安装、卸载、启用、禁用等管理功能
 */

import { EventEmitter } from 'eventemitter3';
import type {
  PluginInfo,
  PluginState,
  PluginError,
  PluginErrorType,
  PluginModule,
  PluginContext,
  PluginInstallOptions,
  PluginEvent,
  PluginEventType,
  PluginOrigin,
  PluginDevSessionRecord,
  PluginEntries,
  Disposable,
  Memento,
  PluginConfigurationManager,
  NormalizedPluginManifest
} from './types';
import { PluginLoader } from './loader';
import { createPluginLocations } from './data-locations';
import { EXTERNALIZED_BUILTIN_PLUGIN_IDS } from './externalized';
import {
  createPluginModuleBlobUrl,
  normalizePluginModulePath
} from './module-urls';
import {
  createPluginScriptStorageKey,
  deletePluginScriptContents,
  estimatePluginScriptBytes,
  loadPluginScriptContents,
  savePluginScriptContents
} from './script-store';

const DEV_SESSIONS_STORAGE_KEY = 'zion.plugins.devSessionsInfo';
const DEV_SESSIONS_MIGRATION_KEY = 'zion.plugins.devSessionsMigrated.v1';
const INSTALLED_PLUGINS_STORAGE_KEY = 'zion.installedPlugins';

/**
 * 插件管理器选项
 */
export interface PluginManagerOptions {
  /** 插件目录路径 */
  pluginDir: string;
  /** 扩展目录路径（向后兼容） */
  extensionsDir?: string;
  /** 是否启用沙箱 */
  sandbox?: boolean;
  /** 是否自动更新 */
  autoUpdate?: boolean;
  /** 日志级别 */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /** 当前 Workbench 是否允许激活这个插件 */
  activationAllowed?: (plugin: PluginInfo) => boolean;
}

/**
 * 插件管理器
 */
export class PluginManager extends EventEmitter {
  private options: Required<Omit<PluginManagerOptions, 'activationAllowed'>>;
  private activationAllowed: (plugin: PluginInfo) => boolean;
  private loader: PluginLoader;
  private plugins = new Map<string, PluginInfo>();
  private activePlugins = new Map<string, { info: PluginInfo; module: PluginModule; context: PluginContext }>();
  private activatingPlugins = new Map<string, Promise<void>>();
  private enabledPlugins = new Set<string>();
  private disabledPlugins = new Set<string>();
  private pluginStyleElements = new Map<string, HTMLStyleElement[]>();

  constructor(options: PluginManagerOptions) {
    super();
    
    this.options = {
      pluginDir: options.pluginDir,
      extensionsDir: options.extensionsDir ?? '',
      sandbox: options.sandbox ?? false,
      autoUpdate: options.autoUpdate ?? false,
      logLevel: options.logLevel ?? 'info'
    };
    const hostActivationAllowed = options.activationAllowed ?? (() => true);
    this.activationAllowed = (plugin) => (
      (
        !EXTERNALIZED_BUILTIN_PLUGIN_IDS.has(plugin.id)
        || this.getPluginOrigin(plugin) === 'external'
      )
      && hostActivationAllowed(plugin)
    );

    this.loader = new PluginLoader({
      logLevel: this.options.logLevel
    });

    this.setupEventHandlers();
  }

  getPluginOrigin(plugin: PluginInfo | null | undefined): PluginOrigin {
    const explicit = plugin?.origin;
    if (explicit === 'builtin' || explicit === 'dev' || explicit === 'external') return explicit;
    const path = String(plugin?.path || '');
    const manifest: any = plugin?.manifest || {};
    const main = String(
      plugin?.contract?.entries?.workbench
      || manifest?.zion?.entries?.workbench
      || manifest?.zion?.entries?.ui
      || manifest?.zion?.main
      || manifest?.main
      || ''
    );
    if (path.startsWith('/extensions/') || main.startsWith('internal:')) return 'builtin';
    if (/\/plugins\/dev\//.test(path) || /\/plugins\/dev\//.test(main)) return 'dev';
    return 'external';
  }

  listDevSessionRecords(): Record<string, PluginDevSessionRecord> {
    const records: Record<string, PluginDevSessionRecord> = {};

    try {
      const raw = localStorage.getItem(DEV_SESSIONS_STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : {};
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [pluginId, value] of Object.entries(saved)) {
          const info = value as Partial<PluginDevSessionRecord> | null;
          const devId = String(info?.devId || '').trim();
          const baseUrl = String(info?.baseUrl || '').trim();
          const dir = String(info?.dir || '').trim();
          if (!pluginId || !devId || !baseUrl || !dir) continue;
          records[pluginId] = { pluginId, devId, baseUrl, dir };
        }
      }

      if (localStorage.getItem(DEV_SESSIONS_MIGRATION_KEY) !== '1') {
        for (const plugin of this.plugins.values()) {
          if (records[plugin.id] || this.getPluginOrigin(plugin) !== 'dev') continue;
          const dir = String(plugin.sourceDir || '').trim();
          const baseUrl = String(plugin.path || '').trim();
          const pathDevId = baseUrl.match(/\/plugins\/dev\/([^/?#]+)/)?.[1] || '';
          const devId = String(plugin.devId || pathDevId).trim();
          if (!dir || !baseUrl || !devId) continue;
          records[plugin.id] = { pluginId: plugin.id, devId, baseUrl, dir };
        }
        localStorage.setItem(DEV_SESSIONS_STORAGE_KEY, JSON.stringify(records));
        localStorage.setItem(DEV_SESSIONS_MIGRATION_KEY, '1');
      }
    } catch (error) {
      this.log('warn', '读取开发会话记录失败', error);
    }

    return records;
  }

  saveDevSessionRecord(record: PluginDevSessionRecord): boolean {
    const pluginId = String(record?.pluginId || '').trim();
    const devId = String(record?.devId || '').trim();
    const baseUrl = String(record?.baseUrl || '').trim();
    const dir = String(record?.dir || '').trim();
    if (!pluginId || !devId || !baseUrl || !dir) return false;

    try {
      const records = this.listDevSessionRecords();
      records[pluginId] = { pluginId, devId, baseUrl, dir };
      localStorage.setItem(DEV_SESSIONS_STORAGE_KEY, JSON.stringify(records));
      localStorage.setItem(DEV_SESSIONS_MIGRATION_KEY, '1');
      return true;
    } catch (error) {
      this.log('warn', `保存开发会话记录失败: ${pluginId}`, error);
      return false;
    }
  }

  removeDevSessionRecord(filter: { pluginId?: string; devId?: string }): boolean {
    const pluginId = String(filter?.pluginId || '').trim();
    const devId = String(filter?.devId || '').trim();
    if (!pluginId && !devId) return false;

    try {
      const records = this.listDevSessionRecords();
      let removed = false;
      for (const [savedPluginId, record] of Object.entries(records)) {
        if ((pluginId && savedPluginId === pluginId) || (devId && record.devId === devId)) {
          delete records[savedPluginId];
          removed = true;
        }
      }
      localStorage.setItem(DEV_SESSIONS_STORAGE_KEY, JSON.stringify(records));
      localStorage.setItem(DEV_SESSIONS_MIGRATION_KEY, '1');
      return removed;
    } catch (error) {
      this.log('warn', '删除开发会话记录失败', error);
      return false;
    }
  }

  private getMainEntry(plugin: PluginInfo): string {
    try {
      const sourceEntries = plugin.sourceEntries;
      if (sourceEntries?.workbench || sourceEntries?.renderer) {
        return [
          sourceEntries.workbench,
          sourceEntries.renderer
        ].filter(Boolean).join('|');
      }
      return [
        this.loader.getEntry(plugin, 'workbench'),
        this.loader.getEntry(plugin, 'renderer')
      ].filter(Boolean).join('|');
    } catch {
      const manifest: any = plugin.manifest as any;
      if (manifest && manifest.zion && typeof manifest.zion.main === 'string') return manifest.zion.main;
      if (manifest && typeof manifest.main === 'string') return manifest.main;
      return '';
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    return this.isRecord(value)
      && Object.values(value).every((item) => typeof item === 'string');
  }

  private scriptSignature(pluginInfo: PluginInfo): string {
    if (pluginInfo.scriptContents) return JSON.stringify(pluginInfo.scriptContents);
    if (pluginInfo.scriptStorageKey) return `stored:${pluginInfo.scriptStorageKey}`;
    return '';
  }

  private projectManifestEntries(
    manifest: PluginInfo['manifest'],
    entries: PluginEntries
  ): PluginInfo['manifest'] {
    if (!this.isRecord(manifest) || !this.isRecord((manifest as any).zion)) {
      return manifest;
    }

    const zion = { ...((manifest as any).zion || {}) };
    const zionEntries = this.isRecord(zion.entries) ? { ...zion.entries } : {};
    if (entries.workbench) {
      zion.main = entries.workbench;
      if (this.isRecord(zion.entries) && zion.entries.workbench) {
        zionEntries.workbench = entries.workbench;
      }
    }
    if (entries.renderer && this.isRecord(zion.entries) && zion.entries.renderer) {
      zionEntries.renderer = entries.renderer;
    }
    if (Object.keys(zionEntries).length) {
      zion.entries = zionEntries;
    }

    return {
      ...(manifest as any),
      zion
    };
  }

  private rehydrateScriptEntries(pluginInfo: PluginInfo): PluginInfo {
    const sources = pluginInfo.scriptContents;
    const sourceEntries = pluginInfo.sourceEntries;
    if (!sources || !sourceEntries) return pluginInfo;

    const contract = pluginInfo.contract || this.loader.normalizeManifest(pluginInfo.manifest);
    const entries: NormalizedPluginManifest['entries'] = { ...contract.entries };
    const cache = new Map<string, string>();
    for (const kind of ['workbench', 'renderer'] as const) {
      const sourceEntry = sourceEntries[kind];
      if (!sourceEntry) continue;
      entries[kind] = createPluginModuleBlobUrl({
        entryPath: normalizePluginModulePath(sourceEntry),
        sources,
        cache
      });
    }

    pluginInfo.contract = {
      ...contract,
      entries
    };
    pluginInfo.manifest = this.projectManifestEntries(pluginInfo.manifest, entries);
    pluginInfo.scriptBlobUrls = Object.fromEntries(cache);
    return pluginInfo;
  }

  private async hydrateScriptContents(pluginInfo: PluginInfo): Promise<PluginInfo> {
    if (pluginInfo.scriptContents || !pluginInfo.scriptStorageKey) return pluginInfo;
    try {
      const stored = await loadPluginScriptContents(pluginInfo.scriptStorageKey);
      if (!stored?.scriptContents) return pluginInfo;
      pluginInfo.scriptContents = stored.scriptContents;
      pluginInfo.sourceEntries = pluginInfo.sourceEntries || stored.sourceEntries;
      pluginInfo.scriptContentBytes = stored.byteSize;
    } catch (error) {
      this.log('warn', `恢复 ZIP 插件脚本源码失败: ${pluginInfo.id}`, error);
    }
    return pluginInfo;
  }

  private createPersistableManifest(pluginInfo: PluginInfo): PluginInfo['manifest'] {
    if (!pluginInfo.sourceEntries) return pluginInfo.manifest;
    return this.projectManifestEntries(pluginInfo.manifest, pluginInfo.sourceEntries);
  }

  private createPersistableContract(pluginInfo: PluginInfo): NormalizedPluginManifest | undefined {
    const contract = pluginInfo.contract;
    if (!contract) return undefined;
    if (!pluginInfo.sourceEntries) return contract;
    return {
      ...contract,
      entries: {
        ...contract.entries,
        ...pluginInfo.sourceEntries
      }
    };
  }

  private revokePluginEntryUrls(pluginInfo: PluginInfo | null | undefined): void {
    if (!pluginInfo) return;
    const urls = new Set<string>();
    for (const url of Object.values(pluginInfo.scriptBlobUrls || {})) {
      if (typeof url === 'string' && url.startsWith('blob:')) urls.add(url);
    }
    try {
      const contract = pluginInfo.contract || this.loader.normalizeManifest(pluginInfo.manifest);
      for (const entry of [contract.entries.workbench, contract.entries.renderer]) {
        if (entry?.startsWith('blob:')) urls.add(entry);
      }
    } catch {}
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    pluginInfo.scriptBlobUrls = undefined;
  }

  private shouldReplaceInstalledPlugin(existing: PluginInfo, incoming: PluginInfo): boolean {
    if (this.getPluginOrigin(incoming) === 'builtin' && this.getPluginOrigin(existing) !== 'builtin') return false;
    const existingScripts = this.scriptSignature(existing);
    const incomingScripts = this.scriptSignature(incoming);
    return (
      existing.version !== incoming.version ||
      existing.path !== incoming.path ||
      this.getMainEntry(existing) !== this.getMainEntry(incoming) ||
      this.getPluginOrigin(existing) !== this.getPluginOrigin(incoming) ||
      existingScripts !== incomingScripts
    );
  }

  /**
   * 初始化插件管理器
   */
  async initialize(options: {
    beforeActivate?: () => Promise<void>;
    deferActivation?: Set<string>;
  } = {}): Promise<void> {
    this.log('info', '初始化插件管理器...');
    
    try {
      // 加载已保存的插件状态（启用/禁用集合）
      await this.loadPluginStates();

      // 恢复已安装插件列表（从 localStorage）
      await this.loadPersistedPlugins();
      
      // 扫描插件目录（向后兼容）
      await this.scanPluginDirectories();
      await options.beforeActivate?.();
      
      // 激活启用的插件
      await this.activateEnabledPlugins(options.deferActivation);
      await this.savePluginStates();
      
      this.log('info', '插件管理器初始化完成');
      
    } catch (error) {
      this.log('error', '插件管理器初始化失败', error);
      throw error;
    }
  }

  registerBuiltinCatalog(catalog: PluginInfo[]): void {
    for (const info of catalog) {
      const existing = this.plugins.get(info.id);
      if (existing && this.getPluginOrigin(existing) !== 'builtin') continue;
      const enabled = this.getEnabledPreference(info.id) ?? info.enabled ?? true;
      this.plugins.set(info.id, { ...info, origin: 'builtin', enabled, state: 'installed' });
      if (enabled) {
        this.enabledPlugins.add(info.id);
        this.disabledPlugins.delete(info.id);
      } else {
        this.disabledPlugins.add(info.id);
        this.enabledPlugins.delete(info.id);
      }
    }
  }

  /**
   * 扫描插件目录
   */
  private async scanPluginDirectories(): Promise<void> {
    this.log('info', '扫描插件目录...');
    
    const directories: Array<{ path: string; type: 'plugins' | 'extensions' }> = [
      { path: this.options.pluginDir, type: 'plugins' },
      { path: this.options.extensionsDir, type: 'extensions' }
    ];

    for (const { path, type } of directories) {
      if (!path) continue;
      
      try {
        // 扫描目录（这里需要实现实际的目录扫描逻辑）
        // 由于是在浏览器环境中，我们需要使用不同的方法
        await this.scanDirectory(path, type);
      } catch (error) {
        this.log('warn', `扫描${type}目录失败: ${path}`, error);
      }
    }
  }

  /**
   * 扫描单个目录
   */
  private async scanDirectory(dirPath: string, type: 'plugins' | 'extensions'): Promise<void> {
    // 在浏览器环境中，我们需要使用不同的方法来扫描目录
    // 这里假设我们有一个方法来获取目录内容
    
    if (type === 'extensions') {
      // 扫描 extensions 目录（向后兼容）
      await this.scanExtensionsDirectory(dirPath);
    } else {
      // 扫描 plugins 目录（新格式）
      await this.scanPluginsDirectory(dirPath);
    }
  }

  /**
   * 扫描 extensions 目录（仅支持 manifest.json）
   */
  private async scanExtensionsDirectory(dirPath: string): Promise<void> {
    try {
      // 扫描 manifest.json（新格式）
      const manifestJsons = (import.meta as any).glob([
        '/extensions/**/manifest.json',
        '!/extensions/dev.identity/manifest.json'
      ], { eager: true }) as Record<string, any>;

      // 处理 manifest.json（新格式）
      for (const [manifestPath, manifestData] of Object.entries(manifestJsons)) {
        try {
          const manifest = manifestData.default || manifestData;
          const pluginPath = manifestPath.replace('/manifest.json', '');
          const dirName = pluginPath.split('/').pop();
          if (!dirName) continue;
          const zionData = (manifest as any)?.zion || {};
          const pluginId = String(zionData.id || manifest.name || `zion.${dirName.replace(/^dev\./, '')}`);
          if (EXTERNALIZED_BUILTIN_PLUGIN_IDS.has(pluginId)) {
            this.log('info', `跳过已外迁内置插件: ${pluginId}`);
            continue;
          }

          const pluginInfo = await this.loader.loadPlugin(pluginPath);
          if (!this.loader.supportsHost(pluginInfo, 'workbench')) {
            this.log('debug', `跳过无 Workbench Entry 的插件包: ${pluginInfo.id}`);
            continue;
          }
          pluginInfo.origin = 'builtin';
          const existing = this.plugins.get(pluginInfo.id);
          if (existing && this.getPluginOrigin(existing) !== 'builtin') {
            this.log('info', `跳过内置插件 ${pluginInfo.id}，保留已安装的${this.getPluginOrigin(existing)}版本`);
            continue;
          }
          const enabledPreference = this.getEnabledPreference(pluginInfo.id);
          this.plugins.set(pluginInfo.id, {
            ...existing,
            ...pluginInfo,
            enabled: enabledPreference ?? existing?.enabled ?? false,
            state: existing?.state ?? pluginInfo.state,
            error: existing?.error,
            createdAt: existing?.createdAt ?? pluginInfo.createdAt,
            updatedAt: Date.now(),
            origin: 'builtin'
          });
          this.log('info', `发现插件: ${pluginInfo.id}`);
        } catch (error) {
          this.log('warn', `加载插件失败: ${manifestPath}`, error);
        }
      }
    } catch (error) {
      this.log('warn', '扫描 extensions 目录失败', error);
    }
  }

  /**
   * 扫描 plugins 目录（新格式）
   */
  private async scanPluginsDirectory(dirPath: string): Promise<void> {
    // 这里需要实现实际的目录扫描逻辑
    // 由于是在浏览器环境中，我们需要使用不同的方法
    
    // 暂时使用模拟数据
    this.log('info', '扫描 plugins 目录（功能待实现）');
  }

  /**
   * 加载并转换扩展插件
   */
  private async loadAndConvertExtension(manifest: any, pluginPath: string): Promise<PluginInfo | null> {
    try {
      // 转换旧格式到新格式
      const convertedManifest = this.convertOldManifest(manifest);
      
      // 使用加载器加载插件
      const pluginInfo = await this.loader.loadPlugin(pluginPath);
      
      // 标记为扩展插件
      pluginInfo.path = pluginPath;
      
      return pluginInfo;
    } catch (error) {
      this.log('warn', `转换扩展插件失败: ${pluginPath}`, error);
      return null;
    }
  }

  /**
   * 转换旧格式清单
   */
  private convertOldManifest(oldManifest: any): any {
    return {
      zion: {
        id: `dev.${oldManifest.name}`,
        name: oldManifest.name,
        version: oldManifest.version || '0.0.1',
        description: oldManifest.description,
        author: oldManifest.author,
        main: oldManifest.main,
        contributes: oldManifest.contributes,
        activationEvents: oldManifest.activationEvents || ['onStartupFinished'],
        engines: { zion: '>=0.1.0' }
      }
    };
  }

  /**
   * 安装插件
   */
  async install(pluginPath: string, options: Partial<PluginInstallOptions> & { enabled?: boolean } = {}): Promise<PluginInfo> {
    const installOptions = {
      enabled: options.enabled ?? true
    } as { enabled: boolean };

    this.log('info', `安装插件: ${pluginPath}`);

    try {
      // 加载插件
      const pluginInfo = await this.loader.loadPlugin(pluginPath);
      
      // 检查是否已安装
      const existing = this.plugins.get(pluginInfo.id);
      if (existing) {
        if (this.shouldReplaceInstalledPlugin(existing, pluginInfo)) {
          this.log('info', `检测到已安装插件版本变化，执行更新: ${pluginInfo.id} ${existing.version} -> ${pluginInfo.version}`);
          return await this.updateFromInfo(pluginInfo, { enabled: installOptions.enabled ?? existing.enabled });
        } else {
          // 同版本：按需启用
          if (installOptions.enabled && !existing.enabled) {
            await this.enable(existing.id);
          }
          this.revokePluginEntryUrls(pluginInfo);
          this.log('info', `插件已安装且为最新: ${existing.id}@${existing.version}`);
          return existing;
        }
      }

      // 添加到插件列表
      this.plugins.set(pluginInfo.id, pluginInfo);
      pluginInfo.enabled = !!installOptions.enabled;
      
      // 如果启用，则激活插件
      if (installOptions.enabled) {
        await this.activate(pluginInfo.id);
      } else {
        this.disabledPlugins.add(pluginInfo.id);
      }

      // 保存状态
      await this.savePluginStates();

      // 触发事件
      this.emit('installed', pluginInfo);
      this.log('info', `插件安装成功: ${pluginInfo.id}`);

      return pluginInfo;

    } catch (error) {
      this.log('error', `插件安装失败: ${pluginPath}`, error);
      throw error;
    }
  }

  /**
   * 直接从 PluginInfo 安装（供 HttpPluginInstaller 使用）
   */
  async installFromInfo(pluginInfo: PluginInfo, options: { enabled?: boolean } = {}): Promise<PluginInfo> {
    const enabled = options.enabled ?? true;
    this.log('info', `从信息安装插件: ${pluginInfo.id}`);

    const existing = this.plugins.get(pluginInfo.id);
    if (existing) {
      // 已安装：如果版本不同则更新，否则根据需要调整启用状态
      if (this.shouldReplaceInstalledPlugin(existing, pluginInfo)) {
        this.log('info', `检测到插件版本变化，准备更新: ${pluginInfo.id} ${existing.version} -> ${pluginInfo.version}`);
        return await this.updateFromInfo(pluginInfo, { enabled });
      } else {
        // 同版本：仅调整启用状态
        if (enabled && !existing.enabled) {
          await this.enable(existing.id);
        } else if (!enabled && existing.enabled) {
          await this.disable(existing.id);
        }
        this.revokePluginEntryUrls(pluginInfo);
        this.log('info', `插件已安装且为最新: ${existing.id}@${existing.version}`);
        return existing;
      }
    }

    // 新安装
    this.plugins.set(pluginInfo.id, pluginInfo);
    pluginInfo.enabled = !!enabled;

    // 触发安装事件
    this.emit('installed', pluginInfo);

    // 根据启用状态处理激活与集合记录
    if (enabled) {
      try {
        await this.activate(pluginInfo.id);
        this.enabledPlugins.add(pluginInfo.id);
      } catch (e) {
        this.log('error', `激活失败: ${pluginInfo.id}`, e);
      }
    } else {
      this.disabledPlugins.add(pluginInfo.id);
    }

    // 保存状态并持久化插件列表
    await this.savePluginStates();

    this.log('info', `插件安装完成: ${pluginInfo.id}`);
    return pluginInfo;
  }

  /**
   * 从 PluginInfo 更新插件（版本变化时）
   */
  async updateFromInfo(pluginInfo: PluginInfo, options: { enabled?: boolean } = {}): Promise<PluginInfo> {
    const existing = this.plugins.get(pluginInfo.id);
    const desiredEnabled = options.enabled ?? (existing?.enabled ?? true);

    if (!existing) {
      // 不存在则执行安装
      return await this.installFromInfo(pluginInfo, { enabled: desiredEnabled });
    }

    if (this.getPluginOrigin(pluginInfo) === 'builtin' && this.getPluginOrigin(existing) !== 'builtin') {
      this.log('info', `跳过内置插件更新 ${pluginInfo.id}，保留已安装的${this.getPluginOrigin(existing)}版本`);
      return existing;
    }

    const existingScripts = this.scriptSignature(existing);
    const incomingScripts = this.scriptSignature(pluginInfo);
    const isEffectivelySame =
      existing.version === pluginInfo.version &&
      existing.path === pluginInfo.path &&
      this.getMainEntry(existing) === this.getMainEntry(pluginInfo) &&
      this.getPluginOrigin(existing) === this.getPluginOrigin(pluginInfo) &&
      existingScripts === incomingScripts &&
      !!existing.enabled === !!desiredEnabled;

    if (isEffectivelySame) {
      const reuseRuntimeModuleUrls = Boolean(
        existing.scriptBlobUrls
        && pluginInfo.scriptBlobUrls
        && existingScripts === incomingScripts
      );
      const merged: PluginInfo = {
        ...existing,
        ...pluginInfo,
        ...(reuseRuntimeModuleUrls
          ? {
              manifest: existing.manifest,
              contract: existing.contract,
              scriptBlobUrls: existing.scriptBlobUrls
            }
          : {}),
        enabled: !!desiredEnabled,
        state: existing.state,
        error: existing.error,
        createdAt: existing.createdAt,
        updatedAt: Date.now()
      };
      if (reuseRuntimeModuleUrls) {
        this.revokePluginEntryUrls(pluginInfo);
      }
      this.plugins.set(pluginInfo.id, merged);
      if (desiredEnabled) {
        this.enabledPlugins.add(pluginInfo.id);
        this.disabledPlugins.delete(pluginInfo.id);
        if (!this.activePlugins.has(pluginInfo.id)) {
          try {
            await this.activate(pluginInfo.id);
          } catch (e) {
            this.log('error', `同步后激活失败: ${pluginInfo.id}`, e);
          }
        }
      } else {
        this.disabledPlugins.add(pluginInfo.id);
        this.enabledPlugins.delete(pluginInfo.id);
      }
      await this.savePluginStates();
      return merged;
    }

    this.log('info', `更新插件: ${pluginInfo.id} ${existing.version} -> ${pluginInfo.version}`);

    // 如处于激活状态，先停用
    if (this.activePlugins.has(pluginInfo.id)) {
      try {
        await this.deactivate(pluginInfo.id);
      } catch (e) {
        this.log('warn', `更新前停用失败: ${pluginInfo.id}`, e);
      }
    }

    // 替换信息并应用启用状态
    this.revokePluginEntryUrls(existing);
    this.plugins.set(pluginInfo.id, pluginInfo);
    pluginInfo.enabled = !!desiredEnabled;

    // 触发更新事件
    this.emit('updated', pluginInfo);

    // 如启用则重新激活
    if (pluginInfo.enabled) {
      try {
        await this.activate(pluginInfo.id);
        this.enabledPlugins.add(pluginInfo.id);
        this.disabledPlugins.delete(pluginInfo.id);
      } catch (e) {
        this.log('error', `更新后激活失败: ${pluginInfo.id}`, e);
      }
    } else {
      this.disabledPlugins.add(pluginInfo.id);
      this.enabledPlugins.delete(pluginInfo.id);
    }

    // 保存状态
    await this.savePluginStates();

    this.log('info', `插件更新完成: ${pluginInfo.id}@${pluginInfo.version}`);
    return pluginInfo;
  }

  /**
   * 从 PluginInfo 热重载插件（开发模式专用）
   * 不检查版本变化，直接重新激活插件
   */
  async hotReloadFromInfo(pluginInfo: PluginInfo, options: { enabled?: boolean; skipNotification?: boolean } = {}): Promise<PluginInfo> {
    const existing = this.plugins.get(pluginInfo.id);
    if (!existing) {
      // 不存在则执行安装
      return await this.installFromInfo(pluginInfo, options);
    }

    this.log('info', `热重载插件: ${pluginInfo.id}`);

    // 如处于激活状态，先停用
    if (this.activePlugins.has(pluginInfo.id)) {
      try {
        await this.deactivate(pluginInfo.id);
      } catch (e) {
        this.log('warn', `热重载前停用失败: ${pluginInfo.id}`, e);
      }
    }

    // 替换信息（保留启用状态）
    this.revokePluginEntryUrls(existing);
    this.plugins.set(pluginInfo.id, {
      ...existing,
      ...pluginInfo,
      enabled: existing.enabled, // 保持原有启用状态
      state: existing.state,
      error: existing.error,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    });

    // 触发热重载事件（区别于 updated 事件）
    this.emit('hotReloaded', {
      plugin: this.plugins.get(pluginInfo.id)!,
      previous: existing,
      timestamp: Date.now(),
      shouldNotify: !options.skipNotification
    });

    // 如启用则重新激活
    if (existing.enabled) {
      try {
        await this.activate(pluginInfo.id);
        this.enabledPlugins.add(pluginInfo.id);
        this.disabledPlugins.delete(pluginInfo.id);
      } catch (e) {
        this.log('error', `热重载后激活失败: ${pluginInfo.id}`, e);
      }
    } else {
      this.disabledPlugins.add(pluginInfo.id);
      this.enabledPlugins.delete(pluginInfo.id);
    }

    // 保存状态
    await this.savePluginStates();

    this.log('info', `插件热重载完成: ${pluginInfo.id}`);
    return this.plugins.get(pluginInfo.id)!;
  }

  /**
   * 从路径更新插件（当已安装且版本变化）
   */
  async update(pluginPath: string, options: Partial<PluginInstallOptions> & { enabled?: boolean } = {}): Promise<PluginInfo> {
    this.log('info', `从路径更新插件: ${pluginPath}`);
    const pluginInfo = await this.loader.loadPlugin(pluginPath);
    const enabled = options.enabled ?? (this.enabledPlugins.has(pluginInfo.id) || this.plugins.get(pluginInfo.id)?.enabled === true);
    return await this.updateFromInfo(pluginInfo, { enabled });
  }

  /**
   * 卸载插件
   */
  async uninstall(pluginId: string): Promise<void> {
    this.log('info', `卸载插件: ${pluginId}`);

    try {
      const pluginInfo = this.plugins.get(pluginId);
      if (!pluginInfo) {
        throw new Error(`插件未找到: ${pluginId}`);
      }

      // 如果插件已激活，先停用
      if (this.activePlugins.has(pluginId)) {
        await this.deactivate(pluginId);
      }

      // 从插件列表中移除
      this.plugins.delete(pluginId);
      this.enabledPlugins.delete(pluginId);
      this.disabledPlugins.delete(pluginId);
      this.revokePluginEntryUrls(pluginInfo);
      await deletePluginScriptContents(pluginInfo.scriptStorageKey);

      // 保存状态
      await this.savePluginStates();

      // 触发事件
      this.emit('uninstalled', pluginInfo);
      this.log('info', `插件卸载成功: ${pluginId}`);

    } catch (error) {
      this.log('error', `插件卸载失败: ${pluginId}`, error);
      throw error;
    }
  }

  /**
   * 启用插件
   */
  async enable(pluginId: string): Promise<void> {
    this.log('info', `启用插件: ${pluginId}`);

    try {
      const pluginInfo = this.plugins.get(pluginId);
      if (!pluginInfo) {
        throw new Error(`插件未找到: ${pluginId}`);
      }

      if (this.enabledPlugins.has(pluginId)) {
        this.log('warn', `插件已启用: ${pluginId}`);
        return;
      }

      // 激活插件
      await this.activate(pluginId);

      // 更新状态
      this.enabledPlugins.add(pluginId);
      this.disabledPlugins.delete(pluginId);
      pluginInfo.enabled = true;

      // 保存状态
      await this.savePluginStates();

      // 触发事件
      this.emit('enabled', pluginInfo);
      this.log('info', `插件启用成功: ${pluginId}`);

    } catch (error) {
      this.log('error', `插件启用失败: ${pluginId}`, error);
      throw error;
    }
  }

  /**
   * 禁用插件
   */
  async disable(pluginId: string): Promise<void> {
    this.log('info', `禁用插件: ${pluginId}`);

    try {
      const pluginInfo = this.plugins.get(pluginId);
      if (!pluginInfo) {
        throw new Error(`插件未找到: ${pluginId}`);
      }

      if (this.disabledPlugins.has(pluginId)) {
        this.log('warn', `插件已禁用: ${pluginId}`);
        return;
      }

      // 停用插件
      await this.deactivate(pluginId);

      // 更新状态
      this.disabledPlugins.add(pluginId);
      this.enabledPlugins.delete(pluginId);
      pluginInfo.enabled = false;

      // 保存状态
      await this.savePluginStates();

      // 触发事件
      this.emit('disabled', pluginInfo);
      this.log('info', `插件禁用成功: ${pluginId}`);

    } catch (error) {
      this.log('error', `插件禁用失败: ${pluginId}`, error);
      throw error;
    }
  }

  /**
   * 激活插件
   */
  activate(pluginId: string): Promise<void> {
    return this.activateWithDependencies(pluginId, []);
  }

  private activateWithDependencies(pluginId: string, ancestors: string[]): Promise<void> {
    if (ancestors.includes(pluginId)) {
      return Promise.reject(new Error(`Plugin dependency cycle: ${[...ancestors, pluginId].join(' -> ')}`));
    }
    const pending = this.activatingPlugins.get(pluginId);
    if (pending) return pending;
    const activation = this.activatePlugin(pluginId, ancestors).finally(() => {
      this.activatingPlugins.delete(pluginId);
    });
    this.activatingPlugins.set(pluginId, activation);
    return activation;
  }

  private async activatePlugin(pluginId: string, ancestors: string[]): Promise<void> {
    this.log('info', `激活插件: ${pluginId}`);

    let context: PluginContext | undefined;
    try {
      const pluginInfo = this.plugins.get(pluginId);
      if (!pluginInfo) {
        throw new Error(`插件未找到: ${pluginId}`);
      }

      if (this.activePlugins.has(pluginId)) {
        this.log('warn', `插件已激活: ${pluginId}`);
        return;
      }
      if (!this.activationAllowed(pluginInfo)) {
        pluginInfo.state = 'installed';
        this.log('info', `当前 Workbench 模式跳过插件激活: ${pluginId}`);
        return;
      }
      if (!this.loader.supportsHost(pluginInfo, 'workbench')) {
        pluginInfo.state = 'installed';
        this.log('info', `插件包 ${pluginId} 未声明 Workbench Host，跳过客户端激活`);
        return;
      }
      for (const dependency of pluginInfo.dependencies || []) {
        const dependencyInfo = this.plugins.get(dependency);
        if (!dependencyInfo || dependencyInfo.state === 'error' || this.getEnabledPreference(dependency) === false) {
          throw new Error(`Plugin dependency unavailable: ${pluginId} -> ${dependency}`);
        }
        await this.activateWithDependencies(dependency, [...ancestors, pluginId]);
        if (!this.activePlugins.has(dependency)) {
          throw new Error(`Plugin dependency inactive: ${pluginId} -> ${dependency}`);
        }
      }

      // 更新状态
      pluginInfo.state = 'activating';
      (pluginInfo as any).activatedAt = Date.now();

      // 加载模块
      const module = await this.loader.loadModule(pluginInfo);
      
      // 创建上下文
      context = this.createPluginContext(pluginInfo);

      // 执行激活函数
      if (typeof module.activate === 'function') {
        await module.activate(context);
      }

      // 添加到激活插件列表
      this.activePlugins.set(pluginId, {
        info: pluginInfo,
        module,
        context
      });

      // 更新最终状态
      await this.autoLoadStyles(pluginInfo);
      pluginInfo.state = 'active';
      pluginInfo.error = undefined;

      // 触发事件
      this.emit('activated', pluginInfo);
      this.log('info', `插件激活成功: ${pluginId}`);

    } catch (error: any) {
      for (const subscription of context?.subscriptions || []) {
        try { subscription.dispose(); } catch {}
      }
      this.activePlugins.delete(pluginId);
      this.removePluginStyles(pluginId);
      // 更新错误状态
      const pluginInfo = this.plugins.get(pluginId);
      if (pluginInfo) {
        pluginInfo.state = 'error';
        pluginInfo.error = {
          type: 'activation_failed',
          message: `插件激活失败: ${error?.message || String(error)}`,
          stack: error?.stack,
          pluginId,
          timestamp: Date.now()
        };
      }

      this.log('error', `插件激活失败: ${pluginId}`, error);
      this.emit('error', { pluginId, error });
      throw error;
    }
  }

  /**
   * 停用插件
   */
  private async autoLoadStyles(info: PluginInfo): Promise<void> {
    try {
      const m = info.manifest as any;
      const styles = m.zion?.contributes?.styles;
      if (!Array.isArray(styles) || styles.length === 0) return;
      const basePath = (info.path || '').replace(/\/+$/, '');
      const els: HTMLStyleElement[] = [];
      for (let i = 0; i < styles.length; i++) {
        try {
          const rel = String(styles[i] || '').replace(/^\.\//, '');
          if (typeof document === 'undefined') continue;
          let css = info.styleContents?.[rel];
          if (typeof css !== 'string') {
            const url = basePath ? basePath + '/' + rel : rel;
            if (!basePath) continue;
            const resp = await fetch(url);
            if (!resp.ok) { this.log('warn', 'Failed style ' + rel + ' for ' + info.id + ': HTTP ' + resp.status); continue; }
            css = await resp.text();
          }
          const id = 'zion-style-' + info.id + '-' + i;
          const old = document.getElementById(id);
          if (old) old.remove();
          const style = document.createElement('style');
          style.id = id;
          style.textContent = css;
          document.head.appendChild(style);
          els.push(style);
        } catch (e) {
          this.log('warn', 'Failed load style for ' + info.id);
        }
      }
      if (els.length > 0) this.pluginStyleElements.set(info.id, els);
    } catch (e) { this.log('warn', 'autoLoadStyles error for ' + info.id); }
  }

  private removePluginStyles(id: string): void {
    const els = this.pluginStyleElements.get(id);
    if (!els) return;
    for (const el of els) { try { if (el.parentNode) el.parentNode.removeChild(el); } catch {} }
    this.pluginStyleElements.delete(id);
  }

  async deactivate(pluginId: string): Promise<void> {
    this.log('info', `停用插件: ${pluginId}`);

    try {
      const activePlugin = this.activePlugins.get(pluginId);
      if (!activePlugin) {
        this.log('warn', `插件未激活: ${pluginId}`);
        return;
      }

      const { info, module, context } = activePlugin;

      // 执行停用函数
      if (module.deactivate) {
        await module.deactivate();
      }

      // 清理订阅
      for (const subscription of context.subscriptions) {
        try {
          subscription.dispose();
        } catch (error) {
          this.log('warn', `清理订阅失败: ${pluginId}`, error);
        }
      }

      // 更新状态
      info.state = 'installed';

      // 从激活插件列表中移除
      this.activePlugins.delete(pluginId);

      // 触发事件
      this.emit('deactivated', info);
      this.log('info', `插件停用成功: ${pluginId}`);

    } catch (error) {
      this.log('error', `插件停用失败: ${pluginId}`, error);
      throw error;
    }
  }

  /**
   * 创建插件上下文
   */
  private createPluginContext(pluginInfo: PluginInfo): PluginContext {
    return {
      subscriptions: [],
      extensionPath: pluginInfo.path,
      locations: createPluginLocations(pluginInfo.id),
      globalState: this.createMemento(`plugin.${pluginInfo.id}.global`),
      workspaceState: this.createMemento(`plugin.${pluginInfo.id}.workspace`),
      configuration: this.createConfigurationManager(pluginInfo.id),
      asAbsolutePath: (relativePath: string) => {
        return `${pluginInfo.path}/${relativePath.replace(/^\.\//, '')}`;
      },
      log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
        this.log(level, `[${pluginInfo.id}] ${message}`);
      }
    };
  }

  /**
   * 创建状态存储
   */
  private createMemento(prefix: string): Memento {
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const fullKey = `${prefix}.${key}`;
        try {
          const value = localStorage.getItem(fullKey);
          return value ? JSON.parse(value) : defaultValue;
        } catch {
          return defaultValue;
        }
      },
      update: async (key: string, value: any): Promise<void> => {
        const fullKey = `${prefix}.${key}`;
        try {
          localStorage.setItem(fullKey, JSON.stringify(value));
        } catch (error) {
          this.log('error', `保存状态失败: ${fullKey}`, error);
        }
      },
      keys: (): string[] => {
        const out: string[] = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix + ".")) {
              out.push(key.slice(prefix.length + 1));
            }
          }
        } catch {}
        return out;
      }
    };
  }

  /**
   * 创建配置管理器
   */
  private createConfigurationManager(pluginId: string): PluginConfigurationManager {
    const configPrefix = `config.${pluginId}`;
    
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const fullKey = `${configPrefix}.${key}`;
        try {
          const value = localStorage.getItem(fullKey);
          return value ? JSON.parse(value) : defaultValue;
        } catch {
          return defaultValue;
        }
      },
      update: async (key: string, value: any): Promise<void> => {
        const fullKey = `${configPrefix}.${key}`;
        try {
          localStorage.setItem(fullKey, JSON.stringify(value));
          // 触发配置变化事件
          this.emit('configChanged', { pluginId, key, value });
        } catch (error) {
          this.log('error', `更新配置失败: ${fullKey}`, error);
        }
      },
      onDidChange: <T>(key: string, callback: (value: T | undefined) => void): Disposable => {
        const handler = (event: any) => {
          if (event && event.pluginId === pluginId && event.key === key) {
            callback(event.value as T);
          }
        };
        this.on('configChanged', handler);
        return {
          dispose: () => {
            this.off('configChanged', handler);
          }
        };
      }
    };
  }

  /**
   * 激活所有启用的插件
   */
  private async activateEnabledPlugins(deferred = new Set<string>()): Promise<void> {
    this.log('info', '启动启用的插件...');

    const enabledPlugins = this.sortPluginIdsByDependencies(
      Array.from(this.enabledPlugins).filter((id) => this.plugins.has(id) && !deferred.has(id))
    );

    for (const pluginId of enabledPlugins) {
      try {
        await this.activate(pluginId);
      } catch (error) {
        this.log('warn', `激活插件失败: ${pluginId}`, error);
      }
    }

    this.log('info', `已启动 ${enabledPlugins.length} 个插件的激活流程`);
  }

  async retryFailedPlugins(): Promise<void> {
    await this.activateEnabledPlugins();
  }

  private sortPluginIdsByDependencies(pluginIds: string[]): string[] {
    const input = new Set(pluginIds);
    const result: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (pluginId: string) => {
      if (visited.has(pluginId)) return;
      if (visiting.has(pluginId)) {
        this.log('warn', `检测到插件依赖循环: ${pluginId}`);
        return;
      }
      visiting.add(pluginId);
      const pluginInfo = this.plugins.get(pluginId);
      for (const depId of pluginInfo?.dependencies || []) {
        if (input.has(depId)) visit(depId);
      }
      visiting.delete(pluginId);
      visited.add(pluginId);
      result.push(pluginId);
    };

    for (const pluginId of pluginIds) visit(pluginId);
    return result;
  }

  /**
   * 加载插件状态
   */
  private async loadPluginStates(): Promise<void> {
    try {
      const savedStates = localStorage.getItem('zion.pluginStates');
      if (savedStates) {
        const states = JSON.parse(savedStates);
        
        // 恢复启用状态
        if (states.enabled) {
          this.enabledPlugins = new Set(states.enabled);
        }
        
        // 恢复禁用状态
        if (states.disabled) {
          this.disabledPlugins = new Set(states.disabled);
        }
        
        this.log('info', '插件状态已恢复');
      }
    } catch (error) {
      this.log('warn', '加载插件状态失败', error);
    }
  }

  /**
   * 保存插件状态
   */
  private async savePluginStates(): Promise<void> {
    const states = {
      enabled: Array.from(this.enabledPlugins),
      disabled: Array.from(this.disabledPlugins),
      timestamp: Date.now()
    };
    const payload = JSON.stringify(states);
    let stateWriteError: unknown = null;
    try {
      localStorage.setItem('zion.pluginStates', payload);
    } catch (error) {
      stateWriteError = error;
    }

    // Always try to rewrite the installed plugin cache. It may be the large
    // value that is preventing even the small enabled/disabled state write.
    await this.persistInstalledPlugins();

    if (stateWriteError) {
      try {
        localStorage.setItem('zion.pluginStates', payload);
      } catch (error) {
        this.log('error', '保存插件状态失败', error);
      }
    }
  }

  /**
   * 从本地存储恢复已安装插件
   */
  private async loadPersistedPlugins(): Promise<void> {
    try {
      const raw = localStorage.getItem(INSTALLED_PLUGINS_STORAGE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;

      for (const rec of arr) {
        try {
          const info: PluginInfo = {
            id: rec.id,
            name: rec.name,
            version: rec.version,
            description: rec.description,
            author: rec.author,
            license: rec.license,
            path: rec.path ?? '',
            manifest: rec.manifest,
            state: 'installed',
            error: undefined,
            dependencies: rec.dependencies ?? [],
            peerDependencies: rec.peerDependencies ?? [],
            createdAt: rec.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            isLegacy: !!rec.isLegacy,
            origin: this.getPluginOrigin(rec as PluginInfo),
            enabled: rec.enabled === true,
            skillContents: this.isStringRecord(rec.skillContents) ? rec.skillContents : undefined,
            skillFiles: rec.skillFiles && typeof rec.skillFiles === 'object' ? rec.skillFiles : undefined,
            styleContents: this.isStringRecord(rec.styleContents) ? rec.styleContents : undefined,
            scriptContents: this.isStringRecord(rec.scriptContents) ? rec.scriptContents : undefined,
            sourceEntries: this.isRecord(rec.sourceEntries) ? rec.sourceEntries as PluginEntries : undefined,
            scriptStorageKey: typeof rec.scriptStorageKey === 'string' ? rec.scriptStorageKey : undefined,
            scriptContentBytes: Number.isFinite(Number(rec.scriptContentBytes))
              ? Number(rec.scriptContentBytes)
              : undefined,
            sourceDir: typeof rec.sourceDir === 'string' ? rec.sourceDir : undefined,
            devId: typeof rec.devId === 'string' ? rec.devId : undefined,
            contract: rec.contract && typeof rec.contract === 'object'
              ? rec.contract
              : undefined
          };
          await this.hydrateScriptContents(info);
          this.rehydrateScriptEntries(info);
          this.plugins.set(info.id, info);

          // 显式保存的偏好优先，避免旧安装记录把已禁用插件重新启用。
          const enabled = this.getEnabledPreference(info.id) ?? info.enabled === true;
          info.enabled = enabled;
          if (enabled) {
            this.enabledPlugins.add(info.id);
            this.disabledPlugins.delete(info.id);
          } else {
            this.disabledPlugins.add(info.id);
            this.enabledPlugins.delete(info.id);
          }
        } catch (e) {
          this.log('warn', '恢复插件失败', e);
        }
      }
    } catch (e) {
      this.log('warn', '加载已安装插件失败', e);
    }
  }

  /**
   * 持久化已安装插件列表到本地存储
   */
  private shouldPersistInstalledPlugin(pluginInfo: PluginInfo): boolean {
    return this.getPluginOrigin(pluginInfo) !== 'builtin';
  }

  private async createPersistablePluginRecord(
    p: PluginInfo,
    { includeEmbeddedAssets = true }: { includeEmbeddedAssets?: boolean } = {}
  ): Promise<Record<string, any>> {
    let scriptStorageKey = p.scriptStorageKey;
    let scriptContentBytes = p.scriptContentBytes;
    if (p.scriptContents && p.sourceEntries) {
      scriptContentBytes = estimatePluginScriptBytes(p.scriptContents);
      try {
        const stored = await savePluginScriptContents({
          key: scriptStorageKey || createPluginScriptStorageKey(p),
          pluginId: p.id,
          version: p.version,
          sourceEntries: p.sourceEntries,
          scriptContents: p.scriptContents
        });
        if (stored) {
          scriptStorageKey = stored.key;
          scriptContentBytes = stored.byteSize;
          p.scriptStorageKey = stored.key;
          p.scriptContentBytes = stored.byteSize;
        }
      } catch (error) {
        this.log('warn', `持久化 ZIP 插件脚本源码失败: ${p.id}`, error);
      }
    }

    return {
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      license: p.license,
      path: p.path,
      manifest: this.createPersistableManifest(p),
      dependencies: p.dependencies,
      peerDependencies: p.peerDependencies,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      isLegacy: p.isLegacy,
      origin: this.getPluginOrigin(p),
      enabled: !!p.enabled,
      ...(includeEmbeddedAssets ? {
        skillContents: p.skillContents,
        skillFiles: p.skillFiles,
        styleContents: p.styleContents
      } : {}),
      sourceEntries: p.sourceEntries,
      scriptStorageKey,
      scriptContentBytes,
      sourceDir: p.sourceDir,
      devId: p.devId,
      contract: this.createPersistableContract(p)
    };
  }

  private writeInstalledPluginRecords(records: Array<Record<string, any>>): void {
    const payload = JSON.stringify(records);
    try {
      localStorage.setItem(INSTALLED_PLUGINS_STORAGE_KEY, payload);
      return;
    } catch (error) {
      // Replacing an old large value can fail while the previous value still
      // occupies quota. Remove it and retry before degrading the record.
      localStorage.removeItem(INSTALLED_PLUGINS_STORAGE_KEY);
      localStorage.setItem(INSTALLED_PLUGINS_STORAGE_KEY, payload);
    }
  }

  private async persistInstalledPlugins(): Promise<void> {
    try {
      const plugins = Array.from(this.plugins.values())
        .filter((plugin) => this.shouldPersistInstalledPlugin(plugin));
      const records = [];
      for (const plugin of plugins) {
        records.push(await this.createPersistablePluginRecord(plugin));
      }
      try {
        this.writeInstalledPluginRecords(records);
        return;
      } catch (error) {
        this.log('warn', '已安装插件记录过大，改写轻量安装记录', error);
      }

      const lightweightRecords = [];
      for (const plugin of plugins) {
        lightweightRecords.push(await this.createPersistablePluginRecord(
          plugin,
          { includeEmbeddedAssets: false }
        ));
      }
      try {
        this.writeInstalledPluginRecords(lightweightRecords);
      } catch (error) {
        localStorage.removeItem(INSTALLED_PLUGINS_STORAGE_KEY);
        this.log('warn', '已安装插件记录超过 localStorage 配额，已清理持久化缓存', error);
      }
    } catch (e) {
      this.log('error', '保存已安装插件失败', e);
    }
  }

  /**
   * 获取插件列表
   */
  list(): PluginInfo[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 获取插件信息
   */
  get(pluginId: string): PluginInfo | null {
    return this.plugins.get(pluginId) || null;
  }

  /**
   * 获取用户保存的启用偏好。未选择过时返回 undefined。
   */
  getEnabledPreference(pluginId: string): boolean | undefined {
    if (this.disabledPlugins.has(pluginId)) return false;
    if (this.enabledPlugins.has(pluginId)) return true;
    return undefined;
  }

  /**
   * 搜索插件
   */
  search(query: string): PluginInfo[] {
    const lowerQuery = query.toLowerCase();
    
    return this.list().filter(plugin => 
      plugin.name.toLowerCase().includes(lowerQuery) ||
      plugin.id.toLowerCase().includes(lowerQuery) ||
      plugin.description?.toLowerCase().includes(lowerQuery) ||
      plugin.author?.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * 获取激活的插件
   */
  getActivePlugins(): PluginInfo[] {
    return Array.from(this.activePlugins.values()).map(item => item.info);
  }

  /**
   * 获取启用的插件
   */
  getEnabledPlugins(): PluginInfo[] {
    return this.list().filter(plugin => plugin.enabled);
  }

  /**
   * 获取禁用的插件
   */
  getDisabledPlugins(): PluginInfo[] {
    return this.list().filter(plugin => !plugin.enabled);
  }

  /**
   * 获取插件统计信息
   */
  getStats(): {
    total: number;
    enabled: number;
    disabled: number;
    active: number;
    errors: number;
  } {
    const plugins = this.list();
    
    return {
      total: plugins.length,
      enabled: this.enabledPlugins.size,
      disabled: this.disabledPlugins.size,
      active: this.activePlugins.size,
      errors: plugins.filter(p => p.state === 'error').length
    };
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // 监听插件事件
    this.on('installed', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已安装: ${pluginInfo.id}`);
    });

    this.on('uninstalled', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已卸载: ${pluginInfo.id}`);
    });

    this.on('enabled', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已启用: ${pluginInfo.id}`);
    });

    this.on('disabled', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已禁用: ${pluginInfo.id}`);
    });

    this.on('activated', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已激活: ${pluginInfo.id}`);
    });

    this.on('deactivated', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已停用: ${pluginInfo.id}`);
    });

    this.on('updated', (pluginInfo: PluginInfo) => {
      this.log('info', `插件已更新: ${pluginInfo.id}@${pluginInfo.version}`);
    });

    this.on('error', (event: { pluginId: string; error: any }) => {
      this.log('error', `插件错误: ${event.pluginId}`, event.error);
    });
  }

  /**
   * 记录日志
   */
  private log(level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: any): void {
    const levels = ['error', 'warn', 'info', 'debug'];
    const currentLevel = levels.indexOf(this.options.logLevel);
    const messageLevel = levels.indexOf(level);
    
    if (messageLevel <= currentLevel) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [PluginManager] [${level.toUpperCase()}] ${message}`;
      
      if (level === 'error') {
        console.error(logMessage, data);
      } else if (level === 'warn') {
        console.warn(logMessage, data);
      } else {
        console.log(logMessage, data);
      }
    }
  }

  /**
   * 销毁插件管理器
   */
  async dispose(): Promise<void> {
    this.log('info', '销毁插件管理器...');
    
    try {
      // 停用所有激活的插件
      const activePluginIds = Array.from(this.activePlugins.keys());
      
      for (const pluginId of activePluginIds) {
        try {
          await this.deactivate(pluginId);
        } catch (error) {
          this.log('warn', `停用插件失败: ${pluginId}`, error);
        }
      }
      
      // 保存状态
      await this.savePluginStates();
      
      // 清理资源
      this.plugins.clear();
      this.activePlugins.clear();
      this.enabledPlugins.clear();
      this.disabledPlugins.clear();
      
      // 移除事件监听器
      this.removeAllListeners();
      
      this.log('info', '插件管理器已销毁');
      
    } catch (error) {
      this.log('error', '销毁插件管理器失败', error);
      throw error;
    }
  }
}
