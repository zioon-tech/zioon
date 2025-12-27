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
  Disposable,
  Memento,
  PluginConfigurationManager
} from './types';
import { PluginLoader } from './loader';

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
}

/**
 * 插件管理器
 */
export class PluginManager extends EventEmitter {
  private options: Required<PluginManagerOptions>;
  private loader: PluginLoader;
  private plugins = new Map<string, PluginInfo>();
  private activePlugins = new Map<string, { info: PluginInfo; module: PluginModule; context: PluginContext }>();
  private enabledPlugins = new Set<string>();
  private disabledPlugins = new Set<string>();

  constructor(options: PluginManagerOptions) {
    super();
    
    this.options = {
      pluginDir: options.pluginDir,
      extensionsDir: options.extensionsDir ?? '',
      sandbox: options.sandbox ?? false,
      autoUpdate: options.autoUpdate ?? false,
      logLevel: options.logLevel ?? 'info'
    };

    this.loader = new PluginLoader({
      logLevel: this.options.logLevel
    });

    this.setupEventHandlers();
  }

  /**
   * 初始化插件管理器
   */
  async initialize(): Promise<void> {
    this.log('info', '初始化插件管理器...');
    
    try {
      // 加载已保存的插件状态（启用/禁用集合）
      await this.loadPluginStates();

      // 恢复已安装插件列表（从 localStorage）
      await this.loadPersistedPlugins();
      
      // 扫描插件目录（向后兼容）
      await this.scanPluginDirectories();
      
      // 激活启用的插件
      await this.activateEnabledPlugins();
      
      this.log('info', '插件管理器初始化完成');
      
    } catch (error) {
      this.log('error', '插件管理器初始化失败', error);
      throw error;
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
   * 扫描 extensions 目录（向后兼容）
   */
  private async scanExtensionsDirectory(dirPath: string): Promise<void> {
    // 使用 Vite 的 glob 功能来扫描 extensions 目录
    try {
      const manifests = (import.meta as any).glob('/extensions/**/extension.json', { eager: true }) as Record<string, any>;
      
      for (const [manifestPath, manifestData] of Object.entries(manifests)) {
        try {
          const manifest = manifestData.default || manifestData;
          const pluginPath = manifestPath.replace('/extension.json', '');
          
          // 转换旧格式
          const pluginInfo = await this.loadAndConvertExtension(manifest, pluginPath);
          
          if (pluginInfo) {
            this.plugins.set(pluginInfo.id, pluginInfo);
            this.log('info', `发现扩展插件: ${pluginInfo.id}`);
          }
        } catch (error) {
          this.log('warn', `加载扩展插件失败: ${manifestPath}`, error);
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
        if (existing.version !== pluginInfo.version) {
          this.log('info', `检测到已安装插件版本变化，执行更新: ${pluginInfo.id} ${existing.version} -> ${pluginInfo.version}`);
          return await this.updateFromInfo(pluginInfo, { enabled: installOptions.enabled ?? existing.enabled });
        } else {
          // 同版本：按需启用
          if (installOptions.enabled && !existing.enabled) {
            await this.enable(existing.id);
          }
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
      if (existing.version !== pluginInfo.version) {
        this.log('info', `检测到插件版本变化，准备更新: ${pluginInfo.id} ${existing.version} -> ${pluginInfo.version}`);
        return await this.updateFromInfo(pluginInfo, { enabled });
      } else {
        // 同版本：仅调整启用状态
        if (enabled && !existing.enabled) {
          await this.enable(existing.id);
        } else if (!enabled && existing.enabled) {
          await this.disable(existing.id);
        }
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

    const getMainEntry = (p: PluginInfo): string => {
      const m: any = p.manifest as any;
      if (m && m.zion && typeof m.zion.main === 'string') return m.zion.main;
      if (m && typeof m.main === 'string') return m.main;
      return '';
    };

    const isEffectivelySame =
      existing.version === pluginInfo.version &&
      existing.path === pluginInfo.path &&
      getMainEntry(existing) === getMainEntry(pluginInfo) &&
      !!existing.enabled === !!desiredEnabled;

    if (isEffectivelySame) {
      const merged: PluginInfo = {
        ...existing,
        ...pluginInfo,
        enabled: !!desiredEnabled,
        state: existing.state,
        error: existing.error,
        createdAt: existing.createdAt,
        updatedAt: Date.now()
      };
      this.plugins.set(pluginInfo.id, merged);
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
  async activate(pluginId: string): Promise<void> {
    this.log('info', `激活插件: ${pluginId}`);

    try {
      const pluginInfo = this.plugins.get(pluginId);
      if (!pluginInfo) {
        throw new Error(`插件未找到: ${pluginId}`);
      }

      if (this.activePlugins.has(pluginId)) {
        this.log('warn', `插件已激活: ${pluginId}`);
        return;
      }

      // 更新状态
      pluginInfo.state = 'activating';
      (pluginInfo as any).activatedAt = Date.now();

      // 加载模块
      const module = await this.loader.loadModule(pluginInfo);
      
      // 创建上下文
      const context = this.createPluginContext(pluginInfo);

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
      pluginInfo.state = 'active';

      // 触发事件
      this.emit('activated', pluginInfo);
      this.log('info', `插件激活成功: ${pluginId}`);

    } catch (error: any) {
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
  private async activateEnabledPlugins(): Promise<void> {
    this.log('info', '激活启用的插件...');
    
    const enabledPlugins = Array.from(this.enabledPlugins);
    
    for (const pluginId of enabledPlugins) {
      try {
        await this.activate(pluginId);
      } catch (error) {
        this.log('warn', `激活插件失败: ${pluginId}`, error);
      }
    }
    
    this.log('info', `已激活 ${enabledPlugins.length} 个插件`);
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
    try {
      const states = {
        enabled: Array.from(this.enabledPlugins),
        disabled: Array.from(this.disabledPlugins),
        timestamp: Date.now()
      };
      
      localStorage.setItem('zion.pluginStates', JSON.stringify(states));

      // 同步持久化已安装插件列表
      this.persistInstalledPlugins();
    } catch (error) {
      this.log('error', '保存插件状态失败', error);
    }
  }

  /**
   * 从本地存储恢复已安装插件
   */
  private async loadPersistedPlugins(): Promise<void> {
    try {
      const raw = localStorage.getItem('zion.installedPlugins');
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
            enabled: rec.enabled === true
          };
          this.plugins.set(info.id, info);

          // 合并启用状态（以已保存集合为准，若不存在则使用记录值）
          const enabled = this.enabledPlugins.has(info.id) || info.enabled === true;
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
  private persistInstalledPlugins(): void {
    try {
      const arr = Array.from(this.plugins.values()).map(p => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        author: p.author,
        license: p.license,
        path: p.path,
        manifest: p.manifest,
        dependencies: p.dependencies,
        peerDependencies: p.peerDependencies,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        isLegacy: p.isLegacy,
        enabled: !!p.enabled
      }));
      localStorage.setItem('zion.installedPlugins', JSON.stringify(arr));
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
