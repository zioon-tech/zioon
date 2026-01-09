/**
 * 插件加载器
 * 负责插件的加载、验证和模块导入
 */

import type {
  PluginInfo,
  PluginManifest,
  ExtensionManifest,
  PluginModule,
  PluginLoaderOptions,
  PluginValidationResult,
  PluginError,
  PluginErrorType
} from './types';

/**
 * 插件加载器
 */
export class PluginLoader {
  private options: Required<PluginLoaderOptions>;
  private cache = new Map<string, PluginInfo>();

  constructor(options: PluginLoaderOptions = {}) {
    this.options = {
      sandbox: options.sandbox ?? false,
      logLevel: options.logLevel ?? 'info',
      timeout: options.timeout ?? 30000
    };
  }

  /**
   * 加载插件
   */
  async loadPlugin(pluginPath: string): Promise<PluginInfo> {
    try {
      // 检查缓存
      if (this.cache.has(pluginPath)) {
        return this.cache.get(pluginPath)!;
      }

      this.log(`Loading plugin from: ${pluginPath}`, 'debug');

      // 检测插件格式
      const format = await this.detectFormat(pluginPath);
      
      // 加载清单文件
      const manifest = await this.loadManifest(pluginPath, format);
      
      // 验证插件
      const validation = await this.validatePlugin(manifest, pluginPath);
      if (!validation.valid) {
        throw new Error(`Plugin validation failed: ${validation.errors.join(', ')}`);
      }

      // 创建插件信息
      const pluginInfo: PluginInfo = {
        id: this.getPluginId(manifest),
        name: this.getPluginName(manifest),
        version: this.getPluginVersion(manifest),
        description: this.getPluginDescription(manifest),
        author: this.getPluginAuthor(manifest),
        license: this.getPluginLicense(manifest),
        path: pluginPath,
        manifest,
        state: 'installed',
        dependencies: this.getDependencies(manifest),
        peerDependencies: this.getPeerDependencies(manifest),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isLegacy: format === 'legacy'
      };

      // 缓存插件信息
      this.cache.set(pluginPath, pluginInfo);

      this.log(`Plugin loaded successfully: ${pluginInfo.id}@${pluginInfo.version}`, 'info');
      return pluginInfo;
    } catch (error) {
      const pluginError: PluginError = {
        type: 'load_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };
      
      this.log(`Failed to load plugin from ${pluginPath}: ${pluginError.message}`, 'error');
      throw pluginError;
    }
  }

  /**
   * 检测插件格式
   */
  private async detectFormat(pluginPath: string): Promise<'modern' | 'legacy'> {
    try {
      // 检查是否存在 manifest.json
      const manifestPath = this.joinPath(pluginPath, 'manifest.json');
      const response = await fetch(manifestPath);
      if (response.ok) {
        return 'modern';
      }
    } catch {
      // 忽略错误，继续检查其他格式
    }

    // 检查是否存在 package.json
    try {
      const packagePath = this.joinPath(pluginPath, 'package.json');
      const response = await fetch(packagePath);
      if (response.ok) {
        const pkg = await response.json();
        if (pkg.zion) {
          return 'modern';
        }
      }
    } catch {
      // 忽略错误
    }

    throw new Error('Unable to detect plugin format');
  }

  /**
   * 加载清单文件
   */
  private async loadManifest(pluginPath: string, format: 'modern' | 'legacy'): Promise<PluginManifest | ExtensionManifest> {
    if (format === 'modern') {
      return await this.loadModernManifest(pluginPath);
    } else {
      return await this.loadLegacyManifest(pluginPath);
    }
  }

  /**
   * 加载新格式清单
   */
  private async loadModernManifest(pluginPath: string): Promise<PluginManifest> {
    // 优先尝试 manifest.json
    try {
      const manifestPath = this.joinPath(pluginPath, 'manifest.json');
      const response = await fetch(manifestPath);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // 忽略错误，尝试 package.json
    }

    // 尝试 package.json
    const packagePath = this.joinPath(pluginPath, 'package.json');
    const response = await fetch(packagePath);
    if (!response.ok) {
      throw new Error(`Failed to load manifest from ${packagePath}`);
    }

    const pkg = await response.json();
    if (!pkg.zion) {
      throw new Error('Package.json does not contain zion field');
    }

    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      zion: pkg.zion
    };
  }

  /**
   * 加载旧格式清单（已废弃）
   */
  private async loadLegacyManifest(pluginPath: string): Promise<ExtensionManifest> {
    throw new Error('Extension format is no longer supported. Please use manifest.json format.');
  }

  /**
   * 验证插件
   */
  private async validatePlugin(manifest: PluginManifest | ExtensionManifest, pluginPath: string): Promise<PluginValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (this.isModernManifest(manifest)) {
        // 验证新格式
        const zion = manifest.zion;
        
        if (!zion.id) {
          errors.push('Plugin ID is required');
        } else if (!this.isValidPluginId(zion.id)) {
          errors.push('Invalid plugin ID format');
        }

        if (!zion.name) {
          errors.push('Plugin name is required');
        }

        if (!zion.version) {
          errors.push('Plugin version is required');
        } else if (!this.isValidVersion(zion.version)) {
          errors.push('Invalid version format');
        }

        if (!zion.main) {
          errors.push('Plugin main entry is required');
        } else {
          // 检查主文件是否存在
          const mainPath = this.joinPath(pluginPath, zion.main);
          try {
            const response = await fetch(mainPath);
            if (!response.ok) {
              errors.push(`Main entry file not found: ${zion.main}`);
            }
          } catch {
            errors.push(`Cannot access main entry file: ${zion.main}`);
          }
        }

        // 验证依赖
        if (zion.dependencies) {
          for (const [depId, version] of Object.entries(zion.dependencies)) {
            if (!this.isValidPluginId(depId)) {
              errors.push(`Invalid dependency ID: ${depId}`);
            }
            if (!this.isValidVersionRange(version)) {
              errors.push(`Invalid version range for dependency ${depId}: ${version}`);
            }
          }
        }

      } else {
        // 验证旧格式（已废弃）
        errors.push('Extension format is no longer supported. Please use manifest.json format.');
      }

      // 通用验证
      if (manifest.version && !this.isValidVersion(manifest.version)) {
        errors.push('Invalid version format');
      }

    } catch (error) {
      errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      manifest
    };
  }

  /**
   * 加载插件模块
   */
  async loadModule(pluginInfo: PluginInfo): Promise<PluginModule> {
    try {
      this.log(`Loading module for plugin: ${pluginInfo.id}`, 'debug');

      const manifest = pluginInfo.manifest;
      let mainPath: string;

      if (this.isModernManifest(manifest)) {
        const candidate = manifest.zion.main || 'index.js';
        // 支持绝对路径（blob:/data:/http(s):）
        if (/^(blob:|data:|https?:|internal:)/i.test(candidate)) {
          mainPath = candidate;
        } else {
          mainPath = this.joinPath(pluginInfo.path, candidate);
        }
      } else {
        const candidate = (manifest as any).main || 'index.js';
        if (/^(blob:|data:|https?:|internal:)/i.test(candidate)) {
          mainPath = candidate;
        } else {
          mainPath = this.joinPath(pluginInfo.path, candidate);
        }
      }

      // 动态导入模块
      const module = await this.dynamicImport(mainPath);
      
      this.log(`Module loaded successfully for plugin: ${pluginInfo.id}`, 'debug');
      return module;
    } catch (error) {
      const pluginError: PluginError = {
        type: 'load_failed',
        message: `Failed to load module for plugin ${pluginInfo.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        stack: error instanceof Error ? error.stack : undefined,
        pluginId: pluginInfo.id,
        timestamp: Date.now()
      };
      
      this.log(pluginError.message, 'error');
      throw pluginError;
    }
  }

  /**
   * 动态导入模块
   */
  private async dynamicImport(path: string): Promise<any> {
    try {
      if (path.startsWith('internal:')) {
        const key = path.slice('internal:'.length);
        const extensionModules = (import.meta as any).glob('/extensions/**/*.{js,ts,jsx,tsx}') as Record<
          string,
          () => Promise<any>
        >;

        const trimmedKey = key.replace(/^\//, '');
        const candidates = trimmedKey.includes('/')
          ? [`/extensions/${trimmedKey}`]
          : [`/extensions/${trimmedKey}/main.js`, `/extensions/${trimmedKey}/index.js`];

        for (const extPath of candidates) {
          const extLoader = extensionModules[extPath];
          if (extLoader) return await extLoader();
        }

        throw new Error(`Unknown internal module: ${key}`);
      }

      // 在浏览器环境中，我们需要使用不同的方式导入模块
      // 这里假设插件已经被构建为可以在浏览器中运行的格式

      // 对 blob:/data:/http(s): 以及标准 .js/.mjs 路径，统一使用 ES 动态 import
      if (/^(blob:|data:|https?:)/i.test(path) || path.endsWith('.js') || path.endsWith('.mjs')) {
        const module = await import(/* @vite-ignore */ path);
        return module;
      }

      // 其他非常规路径，尝试获取内容并以 CommonJS 方式执行（不支持 export 语法）
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch module from ${path}`);
      }

      const content = await response.text();

      // 创建一个新的函数来执行模块代码
      const moduleFunc = new Function('exports', 'require', 'module', '__filename', '__dirname', content);
      const module = { exports: {} };
      const exports = module.exports;
      const require = (id: string) => {
        // 简单的 require 实现
        if (id === 'events') return { EventEmitter: class EventEmitter {} };
        throw new Error(`Module not found: ${id}`);
      };

      moduleFunc(exports, require, module, path, this.getDirname(path));
      return module.exports;
    } catch (error) {
      throw new Error(`Dynamic import failed for ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 解析依赖关系
   */
  async resolveDependencies(pluginInfo: PluginInfo): Promise<void> {
    const dependencies = pluginInfo.dependencies;
    const missing: string[] = [];
    const conflicts: string[] = [];

    for (const depId of dependencies) {
      // 这里需要实现依赖解析逻辑
      // 检查依赖是否存在，版本是否兼容等
      this.log(`Resolving dependency: ${depId} for plugin ${pluginInfo.id}`, 'debug');
    }

    if (missing.length > 0) {
      throw new Error(`Missing dependencies: ${missing.join(', ')}`);
    }

    if (conflicts.length > 0) {
      throw new Error(`Dependency conflicts: ${conflicts.join(', ')}`);
    }
  }

  /**
   * 获取插件ID
   */
  private getPluginId(manifest: PluginManifest | ExtensionManifest): string {
    if (this.isModernManifest(manifest)) {
      return manifest.zion.id;
    } else {
      return manifest.id;
    }
  }

  /**
   * 获取插件名称
   */
  private getPluginName(manifest: PluginManifest | ExtensionManifest): string {
    if (this.isModernManifest(manifest)) {
      return manifest.zion.name;
    } else {
      return manifest.name;
    }
  }

  /**
   * 获取插件版本
   */
  private getPluginVersion(manifest: PluginManifest | ExtensionManifest): string {
    if (this.isModernManifest(manifest)) {
      return manifest.zion.version;
    } else {
      return manifest.version;
    }
  }

  /**
   * 获取插件描述
   */
  private getPluginDescription(manifest: PluginManifest | ExtensionManifest): string | undefined {
    return manifest.description;
  }

  /**
   * 获取插件作者
   */
  private getPluginAuthor(manifest: PluginManifest | ExtensionManifest): string | undefined {
    return manifest.author;
  }

  /**
   * 获取插件许可证
   */
  private getPluginLicense(manifest: PluginManifest | ExtensionManifest): string | undefined {
    if (this.isModernManifest(manifest)) {
      return manifest.license;
    }
    return undefined;
  }

  /**
   * 获取依赖关系
   */
  private getDependencies(manifest: PluginManifest | ExtensionManifest): string[] {
    if (this.isModernManifest(manifest) && manifest.zion.dependencies) {
      return Object.keys(manifest.zion.dependencies);
    }
    return [];
  }

  /**
   * 获取对等依赖关系
   */
  private getPeerDependencies(manifest: PluginManifest | ExtensionManifest): string[] {
    if (this.isModernManifest(manifest) && manifest.zion.peerDependencies) {
      return Object.keys(manifest.zion.peerDependencies);
    }
    return [];
  }

  /**
   * 检查是否为现代格式清单
   */
  private isModernManifest(manifest: PluginManifest | ExtensionManifest): manifest is PluginManifest {
    return 'zion' in manifest;
  }

  /**
   * 验证插件ID格式
   */
  private isValidPluginId(id: string): boolean {
    // 插件ID应该符合反向域名格式，如：com.example.plugin
    return /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(id);
  }

  /**
   * 验证版本格式
   */
  private isValidVersion(version: string): boolean {
    // 支持语义化版本格式：1.0.0, 1.0.0-beta.1 等
    return /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(version);
  }

  /**
   * 验证版本范围格式
   */
  private isValidVersionRange(range: string): boolean {
    // 支持简单的版本范围格式：^1.0.0, ~1.0.0, >=1.0.0 等
    return /^[\^~>=<]*\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(range);
  }

  /**
   * 路径连接
   */
  private joinPath(basePath: string, relativePath: string): string {
    // 简单的路径连接实现
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    const relative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return `${base}/${relative}`;
  }

  /**
   * 获取目录名
   */
  private getDirname(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/') || '/';
  }

  /**
   * 日志记录
   */
  private log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
    if (this.shouldLog(level)) {
      console.log(`[PluginLoader] [${level.toUpperCase()}] ${message}`);
    }
  }

  /**
   * 检查是否应该记录日志
   */
  private shouldLog(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.options.logLevel);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 从缓存中移除插件
   */
  removeFromCache(pluginPath: string): void {
    this.cache.delete(pluginPath);
  }
}
