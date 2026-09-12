/**
 * HTTP插件安装器
 * 支持从HTTP服务安装插件
 */

import JSZip from 'jszip';
import type {
  PluginInfo,
  PluginInstallResult,
  PluginError,
  PluginInstallOptions,
  PluginManifest,
  PluginEntries,
  NormalizedPluginManifest
} from './types';
import { VersionUtils } from './utils';
import {
  normalizePluginManifest,
  validatePluginManifest
} from '../../packages/plugin-sdk/src/manifest.mjs';
import {
  createPluginModuleBlobUrl,
  normalizePluginModulePath
} from './module-urls';

/**
 * HTTP插件安装器选项
 */
export interface HttpPluginInstallerOptions {
  /** 插件服务基础URL */
  baseUrl: string;
  /** 请求超时时间（毫秒） */
  timeout?: number;
  /** 是否启用缓存 */
  cache?: boolean;
}

/**
 * HTTP插件安装器
 */
export class HttpPluginInstaller {
  private options: Required<HttpPluginInstallerOptions>;
  private cache = new Map<string, PluginInfo>();

  constructor(options: HttpPluginInstallerOptions) {
    this.options = {
      baseUrl: options.baseUrl,
      timeout: options.timeout || 30000,
      cache: options.cache ?? true
    };
  }

  /**
   * 从HTTP服务安装插件
   */
  async installFromUrl(
    pluginUrl: string,
    options: Partial<PluginInstallOptions> = {}
  ): Promise<PluginInstallResult> {
    try {
      console.log(`[HttpPluginInstaller] 从URL安装插件: ${pluginUrl}`);

      // 下载插件包
      const pluginData = await this.downloadPlugin(pluginUrl);
      
      // 解压并处理插件数据
      const pluginInfo = await this.processPluginData(pluginData, pluginUrl);
      
      // 验证插件
      const validation = await this.validatePlugin(pluginInfo);
      if (!validation.valid) {
        this.revokePluginEntryUrls(pluginInfo);
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: `插件验证失败: ${validation.errors.join(', ')}`,
            timestamp: Date.now()
          },
          warnings: validation.warnings
        };
      }

      // 检查缓存：如版本和脚本内容一致则复用缓存；否则更新缓存并返回新包内容
      if (this.options.cache && this.cache.has(pluginInfo.id)) {
        const cached = this.cache.get(pluginInfo.id)!;
        if (this.isSameCachedPlugin(cached, pluginInfo)) {
          this.revokePluginEntryUrls(pluginInfo);
          console.log(`[HttpPluginInstaller] 使用缓存插件: ${pluginInfo.id}@${cached.version}`);
          return {
            success: true,
            plugin: cached,
            warnings: validation.warnings
          };
        }
        // 版本或包内容不一致：更新缓存并返回新版本
        console.log(`[HttpPluginInstaller] 检测到插件包变化，更新缓存: ${pluginInfo.id} ${cached.version} -> ${pluginInfo.version}`);
        this.revokePluginEntryUrls(cached);
        this.cache.set(pluginInfo.id, pluginInfo);
        return {
          success: true,
          plugin: pluginInfo,
          warnings: validation.warnings
        };
      }

      // 保存到缓存
      if (this.options.cache) {
        this.cache.set(pluginInfo.id, pluginInfo);
      }

      console.log(`[HttpPluginInstaller] 插件安装成功: ${pluginInfo.id}@${pluginInfo.version}`);
      return {
        success: true,
        plugin: pluginInfo,
        warnings: validation.warnings
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 插件安装失败: ${pluginUrl}`, error);
      
      const pluginError: PluginError = {
        type: 'load_failed',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        error: pluginError,
        warnings: []
      };
    }
  }

  /**
   * 从插件服务安装插件
   */
  async installFromService(
    pluginId: string,
    options: Partial<PluginInstallOptions> = {}
  ): Promise<PluginInstallResult> {
    try {
      console.log(`[HttpPluginInstaller] 从服务安装插件: ${pluginId}`);

      // 构建插件下载URL
      const downloadUrl = `${this.options.baseUrl}/plugins/${pluginId}/download`;
      
      // 使用URL安装
      return await this.installFromUrl(downloadUrl, options);

    } catch (error) {
      console.error(`[HttpPluginInstaller] 从服务安装插件失败: ${pluginId}`, error);
      
      const pluginError: PluginError = {
        type: 'load_failed',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        error: pluginError,
        warnings: []
      };
    }
  }

  /**
   * 开发模式：直接从本地开发目录拉取 manifest.json 并构建 PluginInfo（无需ZIP）
   * baseUrl 形如 http://127.0.0.1:8765/plugins/dev/{devId}
   */
  async installFromDevBase(
    baseUrl: string,
    devId: string,
    options: { sourceDir?: string } = {}
  ): Promise<PluginInstallResult> {
    try {
      const manifestUrl = `${baseUrl}/manifest.json`;
      console.log(`[HttpPluginInstaller] 开发模式安装: ${manifestUrl}`);

      const res = await fetch(manifestUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Zion-Dev-Id': devId,
          'X-Zion-Dev-Mode': 'true'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });
      if (!res.ok) {
        throw new Error(`读取开发清单失败: ${res.status} ${res.statusText}`);
      }
      const manifest = await res.json() as PluginManifest;
      const contract = normalizePluginManifest(manifest);
      const entries = { ...contract.entries };
      for (const kind of ['workbench', 'renderer'] as const) {
        const entry = entries[kind];
        if (!entry) continue;
        const url = /^(blob:|data:|https?:)/i.test(entry)
          ? entry
          : `${baseUrl}/${String(entry).replace(/^\.\//, '')}`;
        entries[kind] = this.withCacheBust(url, `zionDevTs=${Date.now()}`);
      }
      const projectedContract: NormalizedPluginManifest = {
        ...contract,
        entries
      };
      const mainPath = entries.workbench;

      // 构建 PluginInfo
      const pluginInfo: PluginInfo = {
        id: contract.id,
        name: contract.name,
        version: contract.version,
        description: manifest?.description,
        author: manifest?.author,
        license: manifest?.license,
        path: baseUrl,
        manifest: mainPath
          ? {
              ...manifest,
              zion: {
                ...(manifest?.zion || {}),
                main: mainPath
              }
            }
          : manifest,
        state: 'installed',
        dependencies: manifest?.zion?.dependencies ? Object.keys(manifest.zion.dependencies) : [],
        peerDependencies: manifest?.zion?.peerDependencies ? Object.keys(manifest.zion.peerDependencies) : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isLegacy: !manifest?.zion,
        origin: 'dev',
        devId,
        sourceDir: options.sourceDir,
        contract: projectedContract
      };

      // 验证
      const validation = await this.validatePlugin(pluginInfo);
      if (!validation.valid) {
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: `开发清单验证失败: ${validation.errors.join(', ')}`,
            timestamp: Date.now()
          },
          warnings: validation.warnings
        };
      }

      // 缓存处理（按 id）
      if (this.options.cache) {
        const cached = this.cache.get(pluginInfo.id);
        if (cached && cached.version === pluginInfo.version) {
          this.cache.set(pluginInfo.id, {
            ...cached,
            ...pluginInfo,
            state: cached.state,
            enabled: cached.enabled,
            createdAt: cached.createdAt,
            updatedAt: Date.now()
          });
          return { success: true, plugin: this.cache.get(pluginInfo.id)!, warnings: validation.warnings };
        }
        this.cache.set(pluginInfo.id, pluginInfo);
      }

      return { success: true, plugin: pluginInfo, warnings: validation.warnings };
    } catch (error) {
      console.error(`[HttpPluginInstaller] 开发模式安装失败: ${baseUrl}`, error);
      return {
        success: false,
        error: {
          type: 'load_failed',
          message: error instanceof Error ? error.message : '未知错误',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now()
        },
        warnings: []
      };
    }
  }

  private withCacheBust(inputUrl: string, token: string): string {
    try {
      const url = new URL(inputUrl, window.location.href);
      const [key, value] = token.split('=');
      url.searchParams.set(key || 't', value || String(Date.now()));
      return url.toString();
    } catch {
      const separator = inputUrl.includes('?') ? '&' : '?';
      return `${inputUrl}${separator}${token}`;
    }
  }

  private pluginScriptSignature(pluginInfo: PluginInfo): string {
    return JSON.stringify({
      sourceEntries: pluginInfo.sourceEntries || {},
      scriptContents: pluginInfo.scriptContents || {}
    });
  }

  private isSameCachedPlugin(cached: PluginInfo, incoming: PluginInfo): boolean {
    return cached.version === incoming.version
      && this.pluginScriptSignature(cached) === this.pluginScriptSignature(incoming);
  }

  /**
   * 搜索插件
   */
  async searchPlugins(query: string, limit: number = 50): Promise<{
    success: boolean;
    data: Array<{
      id: string;
      name: string;
      version: string;
      description?: string;
      author?: string;
      downloads: number;
      size: number;
    }>;
    error?: PluginError;
  }> {
    try {
      console.log(`[HttpPluginInstaller] 搜索插件: ${query}`);

      const searchUrl = `${this.options.baseUrl}/plugins/search?query=${encodeURIComponent(query)}&limit=${limit}`;
      
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });

      if (!response.ok) {
        throw new Error(`搜索失败: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || '搜索失败');
      }

      // 转换数据格式
      const plugins = result.data.map((plugin: any) => ({
        id: plugin.id,
        name: plugin.metadata?.name || plugin.id,
        version: plugin.metadata?.version || '1.0.0',
        description: plugin.metadata?.description,
        author: plugin.metadata?.author,
        downloads: plugin.download_count || 0,
        size: plugin.file_size || 0
      }));

      return {
        success: true,
        data: plugins
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 搜索插件失败: ${query}`, error);
      
      const pluginError: PluginError = {
        type: 'runtime_error',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        data: [],
        error: pluginError
      };
    }
  }

  /**
   * 获取插件列表
   */
  async listPlugins(limit: number = 100, offset: number = 0): Promise<{
    success: boolean;
    data: Array<{
      id: string;
      name: string;
      version: string;
      description?: string;
      author?: string;
      downloads: number;
      size: number;
    }>;
    total: number;
    error?: PluginError;
  }> {
    try {
      console.log(`[HttpPluginInstaller] 获取插件列表`);

      const listUrl = `${this.options.baseUrl}/plugins?limit=${limit}&offset=${offset}`;
      
      const response = await fetch(listUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });

      if (!response.ok) {
        throw new Error(`获取列表失败: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || '获取列表失败');
      }

      // 转换数据格式
      const plugins = result.data.map((plugin: any) => ({
        id: plugin.id,
        name: plugin.metadata?.name || plugin.id,
        version: plugin.metadata?.version || '1.0.0',
        description: plugin.metadata?.description,
        author: plugin.metadata?.author,
        downloads: plugin.download_count || 0,
        size: plugin.file_size || 0
      }));

      return {
        success: true,
        data: plugins,
        total: result.total || plugins.length
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 获取插件列表失败`, error);
      
      const pluginError: PluginError = {
        type: 'runtime_error',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        data: [],
        total: 0,
        error: pluginError
      };
    }
  }

  /**
   * 获取插件统计信息
   */
  async getStats(): Promise<{
    success: boolean;
    data?: {
      total_plugins: number;
      total_downloads: number;
      total_size_mb: number;
      type_stats: Record<string, number>;
    };
    error?: PluginError;
  }> {
    try {
      console.log(`[HttpPluginInstaller] 获取插件统计`);

      const statsUrl = `${this.options.baseUrl}/plugins/stats`;
      
      const response = await fetch(statsUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(this.options.timeout)
      });

      if (!response.ok) {
        throw new Error(`获取统计失败: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.message || '获取统计失败');
      }

      return {
        success: true,
        data: result.data
      };

    } catch (error) {
      console.error(`[HttpPluginInstaller] 获取插件统计失败`, error);
      
      const pluginError: PluginError = {
        type: 'runtime_error',
        message: error instanceof Error ? error.message : '未知错误',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: Date.now()
      };

      return {
        success: false,
        error: pluginError
      };
    }
  }

  /**
   * 下载插件
   */
  private async downloadPlugin(url: string): Promise<ArrayBuffer> {
    console.log(`[HttpPluginInstaller] 下载插件: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/octet-stream'
      },
      signal: AbortSignal.timeout(this.options.timeout)
    });

    if (!response.ok) {
      throw new Error(`下载失败: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    console.log(`[HttpPluginInstaller] 插件大小: ${contentLength || '未知'} bytes`);

    return await response.arrayBuffer();
  }

  /**
   * 处理插件数据（ZIP解压，读取 manifest，生成主入口 Blob URL）
   */
  private async processPluginData(data: ArrayBuffer, sourceUrl: string): Promise<PluginInfo> {
    console.log(`[HttpPluginInstaller] 处理插件数据: ${sourceUrl}`);

    const zip = await JSZip.loadAsync(data);

    // 尝试读取 manifest.json 或 package.json
    const manifestEntry = zip.file('manifest.json');
    const packageEntry = zip.file('package.json');

    let manifest: any | null = null;

    if (manifestEntry) {
      const txt = await manifestEntry.async('string');
      manifest = JSON.parse(txt);
    } else if (packageEntry) {
      const txt = await packageEntry.async('string');
      const pkg = JSON.parse(txt);
      if (!pkg.zion) {
        throw new Error('package.json 缺少 zion 字段');
      }
      manifest = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        author: pkg.author,
        license: pkg.license,
        zion: pkg.zion
      };
    } else {
      throw new Error('插件包缺少 manifest.json 或 package.json');
    }
    const contract = normalizePluginManifest(manifest);

    const skillContents: Record<string, string> = {};
    const skillFiles: Record<string, Record<string, string>> = {};
    const styleContents: Record<string, string> = {};
    const contributedSkills = [
      ...(Array.isArray(manifest?.zion?.contributes?.skills)
        ? manifest.zion.contributes.skills
        : []),
      ...(contract.entries.skill ? [contract.entries.skill] : [])
    ];
    if (contributedSkills.length) {
      for (const declaredPath of new Set(contributedSkills)) {
        const relativePath = String(declaredPath || '')
          .trim()
          .replace(/\\/g, '/')
          .replace(/^\.\//, '')
          .replace(/\/+$/, '');
        const parts = relativePath.split('/').filter(Boolean);
        if (!parts.length || parts.some((part) => part === '.' || part === '..')) continue;
        const skillDir = parts.join('/');
        const skillPrefix = `${skillDir}/`;
        const files: Record<string, string> = {};
        for (const [entryPath, entry] of Object.entries(zip.files)) {
          if ((entry as any)?.dir) continue;
          if (!entryPath.startsWith(skillPrefix)) continue;
          const relativeFile = entryPath.slice(skillPrefix.length);
          if (!relativeFile || relativeFile.includes('../') || !this.isTextSkillFile(relativeFile)) continue;
          const content = await entry.async('string');
          if (content.length <= 256 * 1024) files[relativeFile] = content;
        }
        if (typeof files['SKILL.md'] === 'string') {
          skillContents[skillDir] = files['SKILL.md'];
          skillFiles[skillDir] = files;
        }
      }
    }

    const contributedStyles = manifest?.zion?.contributes?.styles;
    if (Array.isArray(contributedStyles)) {
      for (const declaredPath of contributedStyles) {
        const relativePath = String(declaredPath || '')
          .trim()
          .replace(/\\/g, '/')
          .replace(/^\.\//, '')
          .replace(/^\/+/, '');
        const parts = relativePath.split('/').filter(Boolean);
        if (!parts.length || parts.some((part) => part === '.' || part === '..')) continue;
        const stylePath = parts.join('/');
        if (!/\.css$/i.test(stylePath)) continue;
        const entry = zip.file(stylePath);
        if (!entry) continue;
        const content = await entry.async('string');
        if (content.length <= 256 * 1024) styleContents[stylePath] = content;
      }
    }

    const scriptContents: Record<string, string> = {};
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if ((entry as any)?.dir) continue;
      let modulePath = '';
      try {
        modulePath = normalizePluginModulePath(entryPath);
      } catch {
        continue;
      }
      if (!/\.(?:mjs|js)$/i.test(modulePath)) continue;
      const content = await entry.async('string');
      if (content.length <= 2 * 1024 * 1024) {
        scriptContents[modulePath] = content;
      }
    }

    const projectedEntries = { ...contract.entries };
    const sourceEntries: PluginEntries = {};
    const moduleUrlCache = new Map<string, string>();
    for (const kind of ['workbench', 'renderer'] as const) {
      const declaredEntry = contract.entries[kind];
      if (!declaredEntry) continue;
      const relativeEntry = normalizePluginModulePath(declaredEntry);
      sourceEntries[kind] = declaredEntry;
      projectedEntries[kind] = createPluginModuleBlobUrl({
        entryPath: relativeEntry,
        sources: scriptContents,
        cache: moduleUrlCache
      });
    }
    const projectedContract: NormalizedPluginManifest = {
      ...contract,
      entries: projectedEntries
    };
    const mainUrl = projectedEntries.workbench;

    // 组装 PluginInfo（使用绝对 mainUrl，loader 将直接动态导入）
    const pluginInfo: PluginInfo = {
      id: contract.id,
      name: contract.name,
      version: contract.version,
      description: manifest?.description,
      author: manifest?.author,
      license: manifest?.license,
      path: sourceUrl, // 保留源，可用于追踪
      manifest: mainUrl
        ? {
            ...manifest,
            zion: {
              ...manifest.zion,
              main: mainUrl
            }
          }
        : manifest,
      state: 'installed',
      dependencies: manifest?.zion?.dependencies ? Object.keys(manifest.zion.dependencies) : [],
      peerDependencies: manifest?.zion?.peerDependencies ? Object.keys(manifest.zion.peerDependencies) : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isLegacy: !manifest?.zion,
      origin: 'external',
      skillContents: Object.keys(skillContents).length ? skillContents : undefined,
      skillFiles: Object.keys(skillFiles).length ? skillFiles : undefined,
      styleContents: Object.keys(styleContents).length ? styleContents : undefined,
      scriptContents: Object.keys(scriptContents).length ? scriptContents : undefined,
      sourceEntries: Object.keys(sourceEntries).length ? sourceEntries : undefined,
      scriptBlobUrls: Object.fromEntries(moduleUrlCache),
      contract: projectedContract
    };

    return pluginInfo;
  }

  private isTextSkillFile(relativePath: string): boolean {
    if (!relativePath || relativePath.split('/').some((part) => part === '.' || part === '..')) return false;
    return /\.(md|mdx|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|xml|html|css|csv)$/i.test(relativePath);
  }

  /**
   * 验证插件
   */
  private async validatePlugin(pluginInfo: PluginInfo): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const shared = pluginInfo.contract
      ? null
      : validatePluginManifest(pluginInfo.manifest);
    if (shared) {
      errors.push(...shared.errors);
      warnings.push(...shared.warnings);
    }

    // 基本验证
    if (!pluginInfo.id) {
      errors.push('插件ID不能为空');
    }

    if (!pluginInfo.name) {
      errors.push('插件名称不能为空');
    }

    if (!pluginInfo.version) {
      errors.push('插件版本不能为空');
    }

    // 清单验证
    if (!pluginInfo.manifest) {
      errors.push('插件清单不能为空');
    }

    const contract = pluginInfo.contract || shared?.normalized;
    if (contract?.hosts.workbench) {
      for (const kind of ['workbench', 'renderer'] as const) {
        const entry = contract.entries[kind];
        if (entry && !/^(blob:|data:|https?:|internal:)/i.test(entry)) {
          warnings.push(`${kind} 入口不是绝对URL，可能无法在浏览器环境加载`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    for (const pluginInfo of this.cache.values()) {
      this.revokePluginEntryUrls(pluginInfo);
    }
    this.cache.clear();
    console.log(`[HttpPluginInstaller] 缓存已清除`);
  }

  /**
   * 从缓存中移除插件
   */
  removeFromCache(pluginId: string): void {
    const cached = this.cache.get(pluginId);
    if (cached) this.revokePluginEntryUrls(cached);
    this.cache.delete(pluginId);
    console.log(`[HttpPluginInstaller] 插件已从缓存移除: ${pluginId}`);
  }

  private revokePluginEntryUrls(pluginInfo: PluginInfo): void {
    const urls = new Set<string>();
    for (const url of Object.values(pluginInfo.scriptBlobUrls || {})) {
      if (typeof url === 'string' && url.startsWith('blob:')) urls.add(url);
    }
    const contract = pluginInfo.contract || normalizePluginManifest(pluginInfo.manifest);
    for (const entry of new Set([
      contract.entries.workbench,
      contract.entries.renderer
    ])) {
      if (entry?.startsWith('blob:')) urls.add(entry);
    }
    for (const url of urls) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    pluginInfo.scriptBlobUrls = undefined;
  }



  /**
   * 直接从本地文件安装（拖拽 ZIP 到前端面板）
   */
  async installFromFile(file: File, options: Partial<PluginInstallOptions> = {}): Promise<PluginInstallResult> {
    try {
      if (!file || !file.name.toLowerCase().endsWith(".zip")) {
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: '仅支持 .zip 插件包文件',
            timestamp: Date.now()
          },
          warnings: []
        };
      }
      console.log(`[HttpPluginInstaller] 从本地文件安装插件: ${file.name}`);
      const buf = await file.arrayBuffer();
      const sourceUrl = `file://${encodeURIComponent(file.name)}`;

      const pluginInfo = await this.processPluginData(buf, sourceUrl);
      const validation = await this.validatePlugin(pluginInfo);
      if (!validation.valid) {
        this.revokePluginEntryUrls(pluginInfo);
        return {
          success: false,
          error: {
            type: 'validation_failed',
            message: `插件验证失败: ${validation.errors.join(', ')}`,
            timestamp: Date.now()
          },
          warnings: validation.warnings
        };
      }

      if (this.options.cache) {
        this.cache.set(pluginInfo.id, pluginInfo);
      }

      return {
        success: true,
        plugin: pluginInfo,
        warnings: validation.warnings
      };
    } catch (error) {
      console.error(`[HttpPluginInstaller] 本地文件安装失败: ${file?.name}`, error);
      return {
        success: false,
        error: {
          type: 'load_failed',
          message: error instanceof Error ? error.message : '未知错误',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now()
        },
        warnings: []
      };
    }
  }

  /**
   * 更新基础服务地址
   */
  setBaseUrl(baseUrl: string): void {
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
      this.options.baseUrl = baseUrl.trim();
      console.log(`[HttpPluginInstaller] 基础URL已更新为: ${this.options.baseUrl}`);
    }
  }
}
